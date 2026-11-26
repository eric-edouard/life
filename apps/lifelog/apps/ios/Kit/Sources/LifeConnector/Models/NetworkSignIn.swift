import Foundation
import Library
import Observation

// His sign-in to a messaging network from the phone (`sign_in_to_network`, `host/network-sign-in.ts`): one bridge login
// step per call. Life keeps no login: the phone carries `loginId`, `stepId` and `type` between calls. His answers
// (passwords, codes, cookies) live only in memory here, are sent once and never logged or kept.

/// `sign_in_to_network`'s arguments: `{network}` starts its sign-in; with a step, his answers to it.
public struct SignInRequest: Encodable, Sendable, Equatable {
    public var network: String
    public var loginId: String?
    public var stepId: String?
    public var type: String?
    public var answers: [String: String]?

    /// The start of the network's sign-in.
    public static func start(_ network: String) -> Self { Self(network: network) }

    /// His answers to `step` (none for a display step: asking again waits for it).
    public static func answering(_ step: SignInStep, of network: String, with answers: [String: String]?) -> Self {
        Self(network: network, loginId: step.loginId, stepId: step.stepId, type: step.type.rawValue, answers: answers)
    }
}

/// One bridge login step as the phone draws it (`stepOf`).
public struct SignInStep: Decodable, Sendable, Equatable {
    /// Life's own enum (mirrored in `ContractTests`). The source and display kinds below are the bridge's
    /// (mautrix bridgev2's login steps), passed through untouched: no server code to mirror them against.
    public enum Kind: String, UnknownTolerant, Sendable {
        case userInput = "user_input"
        case cookies
        case displayAndWait = "display_and_wait"
        case unknown
    }

    /// A form's field; `type` is the bridge's (`email`, `password`, `phone_number`, `2fa_code`…).
    public struct Field: Decodable, Sendable, Equatable {
        public let id: String
        public let name: String
        public let type: String?
        public let description: String?
    }

    /// A web page to sign in on, and where each field's value is found once it reaches `waitForUrlPattern`.
    public struct Cookies: Decodable, Sendable, Equatable {
        public let url: URL
        public let userAgent: String?
        public let waitForUrlPattern: String?
        public let extractJs: String?
        public let fields: [CookieField]
    }

    public struct CookieField: Decodable, Sendable, Equatable {
        public let id: String
        public let required: Bool
        public let sources: [Source]
    }

    public struct Source: Decodable, Sendable, Equatable {
        public enum Kind: String, UnknownTolerant, Sendable {
            case cookie
            case localStorage = "local_storage"
            case requestHeader = "request_header"
            case requestBody = "request_body"
            case special
            case unknown
        }
        public let type: Kind
        public let name: String
        public let cookieDomain: String?
        public let requestUrlRegex: String?
    }

    /// A code or QR to show while the bridge waits for him in the network's app.
    public struct Display: Decodable, Sendable, Equatable {
        public enum Kind: String, UnknownTolerant, Sendable {
            case qr, code, emoji, nothing
            case unknown
        }
        public let type: Kind
        public let data: String?
    }

    public let loginId: String
    public let stepId: String
    public let type: Kind
    /// Markdown, as the bridge words it.
    public let instructions: String?
    public let fields: [Field]?
    public let cookies: Cookies?
    public let display: Display?
}

/// What one call answers.
public enum SignInReply: Equatable, Sendable {
    case step(SignInStep)
    /// A display step he hasn't done yet: ask again with the same step.
    case waiting
    case done

    private struct Wire: Decodable {
        enum Status: String, UnknownTolerant { case step, waiting, done, unknown }
        let status: Status
        let step: SignInStep?
    }

    public static func parsed(_ text: String) throws -> Self {
        let wire = try JSONDecoder().decode(Wire.self, from: Data(text.utf8))
        switch (wire.status, wire.step) {
        case (.step, let step?): return .step(step)
        case (.waiting, _): return .waiting
        case (.done, _): return .done
        default: throw MCPError.failed("Life's answer to a sign-in was not one this app reads.")
        }
    }
}

/// What a web sign-in page gave: its cookies, local storage, the requests it made (headers and body) and `extractJs`'s
/// result. Held in memory while the page is up, never written anywhere.
public struct SignInCatch: Sendable, Equatable {
    public struct Cookie: Sendable, Equatable {
        public let name, domain, value: String
        public init(name: String, domain: String, value: String) {
            (self.name, self.domain, self.value) = (name, domain, value)
        }
    }
    public struct Request: Sendable, Equatable {
        public let url: String
        public let headers: [String: String]
        public let body: String?
        public init(url: String, headers: [String: String], body: String?) {
            (self.url, self.headers, self.body) = (url, headers, body)
        }
    }

    public var cookies: [Cookie] = []
    public var localStorage: [String: String] = [:]
    public var requests: [Request] = []
    /// `extractJs`'s result, by field id: it wins over every other source.
    public var extracted: [String: String] = [:]

    public init() {}

    /// The step's answers by field id, once every required field has a value; nil until then.
    public func answers(for step: SignInStep.Cookies) -> [String: String]? {
        var answers: [String: String] = [:]
        for field in step.fields {
            if let value = extracted[field.id] ?? field.sources.lazy.compactMap(value(of:)).first {
                answers[field.id] = value
            } else if field.required {
                return nil
            }
        }
        return answers
    }

    private func value(of source: SignInStep.Source) -> String? {
        switch source.type {
        case .cookie:
            cookies.last { $0.name == source.name && Self.isDomain($0.domain, in: source.cookieDomain) }?.value
        case .localStorage: localStorage[source.name]
        case .requestHeader:
            requests.reversed().lazy.filter { Self.matches($0.url, source.requestUrlRegex) }
                .compactMap { $0.headers.first { $0.key.caseInsensitiveCompare(source.name) == .orderedSame }?.value }
                .first
        case .requestBody:
            requests.reversed().lazy.filter { Self.matches($0.url, source.requestUrlRegex) }
                .compactMap { $0.body.flatMap { Self.field(source.name, inBody: $0) } }.first
        case .special, .unknown: nil
        }
    }

    /// A cookie set for `.example.com` serves `www.example.com` too, and the other way round.
    static func isDomain(_ domain: String, in wanted: String?) -> Bool {
        guard let wanted else { return true }
        let (have, want) = (domain.trimmingPrefix("."), wanted.trimmingPrefix("."))
        return have == want || want.hasSuffix("." + have) || have.hasSuffix("." + want)
    }

    /// The bridge's patterns are Go's: a match anywhere in the text; none given matches every URL.
    public static func matches(_ url: String, _ pattern: String?) -> Bool {
        guard let pattern else { return true }
        guard let regex = try? Regex(pattern) else { return false }
        return url.contains(regex)
    }

    /// A key of a form-encoded or JSON body.
    static func field(_ name: String, inBody body: String) -> String? {
        if let object = try? JSONSerialization.jsonObject(with: Data(body.utf8)) as? [String: Any] {
            return object[name].map { "\($0)" }
        }
        return URLComponents(string: "?" + body)?.queryItems?.first { $0.name == name }?.value
    }
}

/// One sign-in, step by step: Life's answers drive it, his answers go in once. The sheet draws `phase`.
@MainActor @Observable
public final class NetworkSignIn {
    public enum Phase: Equatable {
        case starting
        /// A step waiting on him: a form or a web page.
        case step(SignInStep)
        /// His answers to this step are on their way.
        case sending(SignInStep)
        /// A code shown while the bridge waits for him in the network's app.
        case waiting(SignInStep)
        case done
        case failed(String)
    }

    public let network: String
    public private(set) var phase = Phase.starting
    private let call: @Sendable (SignInRequest) async throws -> String
    /// The app is off the screen: iOS cuts a held wait, so it is asked again on return.
    private var isAway = false
    private var leftDuringCall = false
    private var isCalling = false
    private var isStopped = false

    public init(network: String, call: @escaping @Sendable (SignInRequest) async throws -> String) {
        self.network = network
        self.call = call
    }

    /// Starts, or starts again after a failure.
    public func start() async {
        phase = .starting
        await run(.start(network))
    }

    /// His answers to the step shown.
    public func submit(_ answers: [String: String]) async {
        guard case .step(let step) = phase else { return }
        phase = .sending(step)
        await run(.answering(step, of: network, with: answers))
    }

    /// The sheet closed: a call under way ends as it ends, and nothing is asked after it.
    public func stop() { isStopped = true }

    /// The app left the screen, or came back: back on a code, the wait is asked again.
    public func setAway(_ away: Bool) async {
        isAway = away
        if away { leftDuringCall = true }
        guard !away, !isCalling, case .waiting(let step) = phase else { return }
        await run(.answering(step, of: network, with: nil))
    }

    private func run(_ first: SignInRequest) async {
        isCalling = true
        defer { isCalling = false }
        var request = first
        while !isStopped {
            leftDuringCall = isAway
            let reply: SignInReply
            do {
                reply = try SignInReply.parsed(try await call(request))
            } catch {
                if isStopped { return }
                // A wait cut while he was in the other app is asked again once he's back.
                if case .waiting = phase, leftDuringCall || isAway {
                    if isAway { return }
                    continue
                }
                phase = Self.ending(error)
                return
            }
            if isStopped { return }
            switch reply {
            case .done:
                phase = .done
                return
            case .step(let step) where step.type == .displayAndWait:
                phase = .waiting(step)
                request = .answering(step, of: network, with: nil)
            case .step(let step) where step.type == .unknown:
                phase = .failed("This step needs a newer Life app. Update it, then try again.")
                return
            case .step(let step):
                phase = .step(step)
                return
            case .waiting:
                guard case .waiting(let step) = phase else {
                    phase = .failed("Life's answer to a sign-in was not one this app reads.")
                    return
                }
                request = .answering(step, of: network, with: nil)
            }
            if isAway { return }
        }
    }

    /// The end of Life's refusal for a network already signed in (`gate`, `host/network-sign-in.ts`): done.
    public nonisolated static let needsNoSignIn = "doesn't need signing in now."

    /// Life's refusal in plain words ("Not done: " dropped); one saying it needs no sign-in is done.
    static func ending(_ error: any Error) -> Phase {
        switch MCPError.of(error) {
        case .refused(let why):
            let words = why.hasPrefix("Not done: ") ? String(why.dropFirst("Not done: ".count)) : why
            return words.hasSuffix(needsNoSignIn) ? .done : .failed(words)
        case .unreachable, .timedOut, .streamDropped: return .failed("Life can't reach your Mac right now.")
        case let other: return .failed(other.reason)
        }
    }
}
