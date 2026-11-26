#if DEBUG
    import Foundation
    import LifeConnector
    import Synchronization
    import UIKit

    /// A fake Life inside the app, for the end-to-end tests (`LifelogE2E`, which launches the app with these arguments):
    ///
    /// - `-e2eScenario <file>`: the scenario (see `E2EScenario`); `-e2eFixtures <dir>`: `apps/lifelog/fixtures`;
    ///   `-e2eDir <dir>`: where the test and the app meet: the app appends every call to `calls.jsonl`, the test writes
    ///   the number of the scenario's current step to `step`.
    /// - `-e2ePaired <origin>`: starts paired to that fake Life; `-e2eReset`: forgets the pairing and the kept reads first;
    ///   `-e2eOpenURL <link>`: opens a pairing link once the app is up; `-e2eClock <instant>`: the stores' `now`.
    ///
    /// A `URLProtocol` answers every request to `life-<origin>.e2e.test`: the sign-in and `/mcp` (streamed progress,
    /// scripted drops, unreachable steps, repeats of an answer served as Life's `answerWithResult` does).
    /// Nothing here is in a Release build.
    enum E2E {
        private nonisolated(unsafe) static let defaults = UserDefaults.standard
        nonisolated static let isOn = defaults.string(forKey: "e2eScenario") != nil
        private static let dir = defaults.string(forKey: "e2eDir").map { URL(filePath: $0) }

        /// The stores' clock: fixed when `-e2eClock` gives an instant.
        static let now: @Sendable () -> Date = {
            let fixed = defaults.string(forKey: "e2eClock").flatMap { try? Date($0, strategy: .iso8601) }
            return { fixed ?? Date() }
        }()

        /// Before any store opens: the protocol, a clean start, the seeded pairing. Animations off.
        static func install() {
            guard isOn, let dir, let file = defaults.string(forKey: "e2eScenario"),
                let scenario = try? JSONDecoder().decode(
                    E2EScenario.self, from: Data(contentsOf: URL(filePath: file)))
            else { return }
            if !defaults.bool(forKey: "e2eKeepAnimations") { UIView.setAnimationsEnabled(false) }
            let fixtures = URL(filePath: defaults.string(forKey: "e2eFixtures") ?? "")
            FakeLife.state.withLock { $0 = FakeLife.Held(scenario: scenario, fixtures: fixtures, dir: dir) }
            MCPClient.protocolsOfTests = [FakeLife.self]
            // The lab's voice clips play a quiet tone (the fixtures' job), so read-along runs with no server.
            ClipAudio.writeTone(job: "11111111-2222-3333-4444-555555555555", seconds: 5)
            if defaults.bool(forKey: "e2eReset") {
                LifeToken().clear()
                let support = URL.applicationSupportDirectory.appending(path: "lifelog")
                for name in ["life-reads", "life-thread"] {
                    try? FileManager.default.removeItem(at: support.appending(path: name))
                }
            }
            if let origin = defaults.string(forKey: "e2ePaired"), LifeToken().load() == nil {
                let host = FakeLife.origin(of: origin)
                LifeToken().save(
                    LifeCredentials(
                        endpoint: LifeEndpoint(
                            origin: host, clientID: "e2e-client", tokenEndpoint: host.appending(path: "token"),
                            resource: host.appending(path: "mcp").absoluteString),
                        tokens: LifeTokens(access: "e2e-access", refresh: "e2e-refresh", expiresAt: .distantFuture)))
            }
        }

        /// Once the stores stand: a link to open, and the test's steps: a new one reads Life again (the app's own
        /// reaction to a change of network path), so a screen shows what the step changed.
        static func start(life: LifeStore) {
            guard isOn, let dir else { return }
            if let link = defaults.string(forKey: "e2eOpenURL").flatMap(URL.init(string:)) {
                Task {
                    try? await Task.sleep(for: .seconds(1))
                    await UIApplication.shared.open(link)
                }
            }
            Task {
                var seen = FakeLife.step(in: dir)
                while !Task.isCancelled {
                    try? await Task.sleep(for: .milliseconds(100))
                    let step = FakeLife.step(in: dir)
                    guard step != seen else { continue }
                    seen = step
                    await life.refresh()
                }
            }
        }
    }

    /// One flow's script. Steps are cumulative: `up` (the origins that answer) and `reads` (a read tool's fixture) hold
    /// until a later step changes them. `answers` are matched in order, each used once. `expect` is the test's to check.
    struct E2EScenario: Decodable, Sendable {
        struct Step: Decodable, Sendable {
            var up: [String]?
            var reads: [String: String]?
        }
        struct Answer: Decodable, Sendable {
            var ref: String
            var options: [String]
            /// The steps Life reports before its result.
            var progress: [String]?
            /// `before_result`: the connection closes once the progress is sent (the answer was recorded all the same).
            var drop: String?
            /// The result: a fixture of `wire/`, or a tool error text.
            var then: String?
            var error: String?
            /// Life's state moves on once it has this answer: the next step begins.
            var advance: Bool?
        }
        var name: String
        var origins: [String: String]
        var steps: [Step]
        var answers: [Answer] = []
        /// What his round button's ask brings back: an answer holding an `items` block of these asks.
        var items: [String] = []
        /// The answer's words before its block (`life:` links to open a page from); by default a line that counts the asks ("Five things wait on you:").
        var text: String?
        /// Seconds between the lines of that answer, which then comes as it is written: a step, its words a few at a time,
        /// then its block (for watching motion).
        var pace: Double?
        /// `sign_in_to_network`'s replies, a `wire/` fixture holding them in order: each call takes the next.
        var signIn: String?
    }

    nonisolated final class FakeLife: URLProtocol, @unchecked Sendable {
        /// Life's lead line over its asks: it counts them (the lab's "Five things wait on you:").
        static func lead(counting count: Int) -> String {
            guard count > 1 else { return "It waits on you." }
            let formatter = NumberFormatter()
            formatter.numberStyle = .spellOut
            formatter.locale = Locale(identifier: "en")
            let number = formatter.string(from: NSNumber(value: count)) ?? "\(count)"
            return "\(number.prefix(1).uppercased() + number.dropFirst()) things wait on you:"
        }

        struct Held {
            let scenario: E2EScenario
            let fixtures: URL
            let dir: URL
            var used: Set<Int> = []
            /// An answered ask's first result: a repeat of the same answer gets it, under any key.
            var answered: [String: String] = [:]
            /// How many sign-in replies were given.
            var signedIn = 0
        }
        static let state = Mutex<Held?>(nil)

        static func origin(of name: String) -> URL {
            URL(string: "https://life-\(name).e2e.test") ?? URL(filePath: "/")
        }
        static func step(in dir: URL) -> Int {
            (try? String(contentsOf: dir.appending(path: "step"), encoding: .utf8))
                .flatMap { Int($0.trimmingCharacters(in: .whitespacesAndNewlines)) } ?? 0
        }

        override class func canInit(with request: URLRequest) -> Bool {
            request.url?.host()?.hasSuffix(".e2e.test") == true
        }
        override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
        override func stopLoading() { Self.note("stopped \(request.url?.path() ?? "")") }
        static func note(_ text: String) {
            guard let dir = state.withLock({ $0?.dir }),
                let data = try? JSONSerialization.data(withJSONObject: ["note": text])
            else { return }
            let file = dir.appending(path: "calls.jsonl")
            if let handle = try? FileHandle(forWritingTo: file) {
                handle.seekToEndOfFile()
                handle.write(data + Data("\n".utf8))
                try? handle.close()
            }
        }

        // MARK: Answering

        private struct Reply {
            var status = 200
            var headers = ["content-type": "application/json"]
            var chunks: [Data] = []
            var failure: URLError.Code?
            var pace: Double?
        }

        private static func json(_ object: Any, status: Int = 200) -> Reply {
            Reply(status: status, chunks: [(try? JSONSerialization.data(withJSONObject: object)) ?? Data()])
        }

        override func startLoading() {
            guard let url = request.url, let host = url.host(), let reply = reply(to: url, host: host) else { return }
            if let failure = reply.failure, reply.chunks.isEmpty {
                return client?.urlProtocol(self, didFailWithError: URLError(failure)) ?? ()
            }
            guard
                let response = HTTPURLResponse(
                    url: url, statusCode: reply.status, httpVersion: "HTTP/1.1", headerFields: reply.headers)
            else { return }
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            for chunk in reply.chunks {
                if let pace = reply.pace { Thread.sleep(forTimeInterval: pace) }
                client?.urlProtocol(self, didLoad: chunk)
            }
            if let failure = reply.failure {
                client?.urlProtocol(self, didFailWithError: URLError(failure))
            } else {
                client?.urlProtocolDidFinishLoading(self)
            }
        }

        private var body: [String: Any] {
            var data = request.httpBody ?? Data()
            if let stream = request.httpBodyStream {
                stream.open()
                var buffer = [UInt8](repeating: 0, count: 4096)
                while stream.hasBytesAvailable {
                    let n = stream.read(&buffer, maxLength: buffer.count)
                    if n <= 0 { break }
                    data.append(buffer, count: n)
                }
                stream.close()
            }
            return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
        }

        private func form(_ data: Data) -> [String: String] {
            Dictionary(
                String(decoding: data, as: UTF8.self).split(separator: "&").map { pair in
                    let parts = pair.split(separator: "=", maxSplits: 1).map {
                        String($0).removingPercentEncoding ?? ""
                    }
                    return (parts[0], parts.count > 1 ? parts[1] : "")
                }, uniquingKeysWith: { $1 })
        }

        private func reply(to url: URL, host: String) -> Reply? {
            guard let held = Self.state.withLock({ $0 }) else { return nil }
            let name = host.dropFirst("life-".count).split(separator: ".").first.map(String.init) ?? ""
            let step = Self.step(in: held.dir)
            let steps = held.scenario.steps.prefix(step + 1)
            let isUp = steps.last(where: { $0.up != nil })?.up?.contains(name) ?? true
            func log(_ fields: [String: Any]) {
                var line = fields
                line["origin"] = name
                guard let data = try? JSONSerialization.data(withJSONObject: line, options: .sortedKeys) else { return }
                let file = held.dir.appending(path: "calls.jsonl")
                if !FileManager.default.fileExists(atPath: file.path) {
                    FileManager.default.createFile(atPath: file.path, contents: nil)
                }
                if let handle = try? FileHandle(forWritingTo: file) {
                    handle.seekToEndOfFile()
                    handle.write(data + Data("\n".utf8))
                    try? handle.close()
                }
            }
            guard isUp else {
                log(["unreachable": url.path()])
                return Reply(failure: .cannotConnectToHost)
            }
            let origin = "https://\(host)"
            switch url.path() {
            case "/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-protected-resource":
                return Self.json(["resource": "\(origin)/mcp", "authorization_servers": [origin]])
            case "/.well-known/oauth-authorization-server":
                return Self.json([
                    "authorization_endpoint": "\(origin)/authorize", "token_endpoint": "\(origin)/token",
                    "registration_endpoint": "\(origin)/register",
                ])
            case "/register": return Self.json(["client_id": "e2e-client-\(name)"], status: 201)
            case "/authorize":
                let fields = form(request.httpBody ?? Data(request.httpBodyStream.flatMap(Self.read) ?? Data()))
                let isRight = fields["pairing"] == held.scenario.origins[name]
                log(["authorize": isRight ? "approved" : "wrong_code"])
                guard isRight else { return Reply(headers: ["content-type": "text/html"], chunks: [Data("pair".utf8)]) }
                return Reply(
                    status: 302,
                    headers: ["location": "http://127.0.0.1/life-app?code=e2e-code&state=\(fields["state"] ?? "")"])
            case "/token":
                log(["token": "issued"])
                return Self.json([
                    "access_token": "e2e-access-\(name)", "refresh_token": "e2e-refresh-\(name)", "expires_in": 3600,
                ])
            case "/mcp": return tool(held: held, name: name, step: step, steps: Array(steps), log: log)
            default: return Self.json([:], status: 404)
            }
        }

        private static func read(_ stream: InputStream) -> Data {
            var data = Data()
            stream.open()
            var buffer = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable {
                let n = stream.read(&buffer, maxLength: buffer.count)
                if n <= 0 { break }
                data.append(buffer, count: n)
            }
            stream.close()
            return data
        }

        private func fixture(_ path: String, in held: Held) -> String {
            (try? String(contentsOf: held.fixtures.appending(path: "wire/\(path)"), encoding: .utf8)) ?? "{}"
        }

        private static func message(_ result: String, isError: Bool = false) -> String {
            let content = [["type": "text", "text": result]]
            let object: [String: Any] = [
                "jsonrpc": "2.0", "id": 1, "result": ["content": content, "isError": isError],
            ]
            return String(decoding: (try? JSONSerialization.data(withJSONObject: object)) ?? Data(), as: UTF8.self)
        }

        private static func progress(_ token: String, _ line: Any) -> String {
            let text = String(decoding: (try? JSONSerialization.data(withJSONObject: line)) ?? Data(), as: UTF8.self)
            let object: [String: Any] = [
                "jsonrpc": "2.0", "method": "notifications/progress",
                "params": ["progressToken": token, "progress": 1, "message": text],
            ]
            return String(decoding: (try? JSONSerialization.data(withJSONObject: object)) ?? Data(), as: UTF8.self)
        }

        private static func stream(_ events: [String], then failure: URLError.Code? = nil, pace: Double? = nil) -> Reply
        {
            Reply(
                headers: ["content-type": "text/event-stream"],
                chunks: events.map { Data("data: \($0)\n\n".utf8) }, failure: failure, pace: pace)
        }

        /// One `tools/call`.
        private func tool(
            held: Held, name: String, step: Int, steps: [E2EScenario.Step], log: ([String: Any]) -> Void
        ) -> Reply {
            let params = body["params"] as? [String: Any] ?? [:]
            let tool = params["name"] as? String ?? ""
            let arguments = params["arguments"] as? [String: Any] ?? [:]
            let meta = params["_meta"] as? [String: Any] ?? [:]
            let token = meta["progressToken"] as? String
            let key = meta["life/answerKey"] as? String
            func ended(_ text: String, isError: Bool = false, lines: [Any] = [], pace: Double? = nil) -> Reply {
                guard let token else { return Reply(chunks: [Data(Self.message(text, isError: isError).utf8)]) }
                return Self.stream(
                    lines.map { Self.progress(token, $0) } + [Self.message(text, isError: isError)], pace: pace)
            }
            switch tool {
            case "answer_check":
                let ref = arguments["ref"] as? String ?? ""
                let options = arguments["options"] as? [String] ?? []
                let reply: (text: String, isError: Bool, lines: [Any], drop: Bool, outcome: String, advances: Bool)? =
                    Self.state.withLock { held in
                        guard var now = held else { return nil }
                        defer { held = now }
                        if let first = now.answered[ref] {
                            return (first, false, [], false, "repeat", true)
                        }
                        let scenario = now.scenario
                        guard
                            let at = scenario.answers.indices.first(where: {
                                !now.used.contains($0) && scenario.answers[$0].ref == ref
                                    && scenario.answers[$0].options == options
                            })
                        else { return nil }
                        now.used.insert(at)
                        let answer = scenario.answers[at]
                        let steps = answer.progress ?? []
                        let lines: [Any] =
                            steps.isEmpty ? [] : [["plan": steps, "limitSeconds": 45]] + steps.map { ["step": $0] }
                        let text =
                            answer.error ?? answer.then.flatMap {
                                try? String(contentsOf: now.fixtures.appending(path: "wire/\($0)"), encoding: .utf8)
                            } ?? "{}"
                        if answer.error == nil, text.contains("\"state\": \"answered\"") { now.answered[ref] = text }
                        return (
                            text, answer.error != nil, lines, answer.drop == "before_result",
                            answer.error != nil
                                ? "refused"
                                : answer.drop != nil
                                    ? "dropped" : answer.then?.contains("not_sent") == true ? "not_sent" : "answered",
                            answer.advance == true
                        )
                    }
                log([
                    "tool": tool, "ref": ref, "options": options, "key": key ?? "",
                    "undo": arguments["undo"] as? Bool ?? false, "rate": arguments["rate"] as? String ?? "",
                    "person": arguments["person"] as? String ?? "",
                    "outcome": reply?.outcome ?? "unmatched",
                ])
                if reply?.advances == true {
                    try? String(step + 1).write(to: held.dir.appending(path: "step"), atomically: true, encoding: .utf8)
                }
                guard let reply else { return Self.stream([Self.message("No scripted answer.", isError: true)]) }
                if reply.drop, let token {
                    return Self.stream(reply.lines.map { Self.progress(token, $0) }, then: .networkConnectionLost)
                }
                return ended(reply.text, isError: reply.isError, lines: reply.lines)
            case "sign_in_to_network":
                // His answers are never logged: their names only.
                log(["tool": tool, "arguments": arguments.keys.sorted(), "type": arguments["type"] as? String ?? ""])
                let replies =
                    held.scenario.signIn.flatMap {
                        try? JSONSerialization.jsonObject(with: Data(fixture($0, in: held).utf8)) as? [Any]
                    } ?? []
                let at = Self.state.withLock { now -> Int in
                    defer { now?.signedIn += 1 }
                    return now?.signedIn ?? 0
                }
                guard at < replies.count, let data = try? JSONSerialization.data(withJSONObject: replies[at]) else {
                    return ended("Not done: LINE didn't accept that. Try again.", isError: true)
                }
                // A held wait answers after a while, with its progress pings.
                let isWait = arguments["type"] as? String == "display_and_wait"
                return ended(
                    String(decoding: data, as: UTF8.self), lines: isWait ? [["step": "waiting"]] : [],
                    pace: isWait ? 4 : nil)
            case "ask_main_session":
                guard let words = arguments["words"] as? String else {
                    return ended(#"{"kind":"reply","entry":0,"text":"","refs":[],"acts":[]}"#)
                }
                log(["tool": tool, "words": words])
                let blocks =
                    held.scenario.items.isEmpty
                    ? ""
                    : "\n\n```life:items\n"
                        + (String(
                            decoding: (try? JSONSerialization.data(withJSONObject: held.scenario.items)) ?? Data(),
                            as: UTF8.self)) + "\n```"
                let lead = held.scenario.text ?? Self.lead(counting: held.scenario.items.count)
                let text = lead + blocks
                let reply: [String: Any] = [
                    "kind": "reply", "entry": 1, "text": text, "refs": held.scenario.items, "acts": [],
                ]
                let spokenWords = lead.split(separator: " ").map(String.init)
                let spoken: [[String: Any]] =
                    held.scenario.pace == nil
                    ? []
                    : stride(from: 0, to: spokenWords.count, by: 4).map {
                        [
                            "kind": "words",
                            "text": spokenWords[$0..<min($0 + 4, spokenWords.count)].joined(separator: " ") + " ",
                        ]
                    }
                let lines: [[String: Any]] =
                    [["kind": "step", "verb": "Reading", "what": "your asks"]] + spoken
                    + (held.scenario.items.isEmpty
                        ? [] : [["kind": "block", "type": "items", "block": held.scenario.items]])
                return ended(
                    String(decoding: (try? JSONSerialization.data(withJSONObject: reply)) ?? Data(), as: UTF8.self),
                    lines: lines, pace: held.scenario.pace)
            default:
                let path = steps.reversed().compactMap { $0.reads?[tool] }.first
                let text = path.map { fixture($0, in: held) } ?? "{}"
                log(["tool": tool, "bytes": text.utf8.count])
                return ended(text)
            }
        }
    }
#endif
