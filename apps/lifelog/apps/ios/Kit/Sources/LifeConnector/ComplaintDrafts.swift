import Foundation
import Observation

/// His "Wrong…" on each card, from the sheet's opening until Life's complaint receipt: the card as he opened the sheet
/// on it, his words and tick, and the press as first sent with the Life it went to. The store keeps them above every
/// read, so a refresh, the card leaving or the sheet closing loses nothing, and Try again resends that press (its seal,
/// so its key) to that Life: the caretaker is never asked twice. A new pairing drops them all.
@MainActor @Observable
public final class ComplaintDrafts {
    /// One press: the request and the Life it is decided for.
    public struct Press: Sendable, Equatable {
        public let request: AnswerRequest
        public let life: PairedLife
    }

    public struct Draft: Sendable, Equatable {
        /// The card as he opened the sheet on it: what the sheet shows and what the press seals.
        public let check: Check
        public var words = ""
        public var report = false
        /// The press as first sent, resent while his words and tick are as they were.
        public fileprivate(set) var sent: Press?
        /// Life's complaint receipt for that press (its ask): the sheet says so, then closes.
        public fileprivate(set) var receipt: String?

        init(check: Check) { self.check = check }
    }

    private var drafts: [String: Draft] = [:]

    public init() {}

    /// His draft on the card `ref`: the sheet binds his words and tick to it.
    public subscript(ref: String) -> Draft? {
        get { drafts[ref] }
        set { drafts[ref] = newValue }
    }

    /// The sheet opens on `check`: his draft on it is kept, unless its press reached the caretaker; then a new one on the
    /// card as it is now. True when the draft is new.
    @discardableResult public func open(_ check: Check) -> Bool {
        if let kept = drafts[check.ref], kept.receipt == nil { return false }
        drafts[check.ref] = Draft(check: check)
        return true
    }

    /// What his tap sends on `ref`: the press as first sent while his words and tick are unchanged, else a new one on
    /// the card he opened, to `life` (the Life paired now). Nil while there is nothing to send.
    public func press(_ ref: String, to life: PairedLife) -> Press? {
        guard var draft = drafts[ref], draft.receipt == nil else { return nil }
        let words = draft.words.trimmingCharacters(in: .whitespacesAndNewlines)
        if let sent = draft.sent, sent.request.note == words, sent.request.value?.report == draft.report { return sent }
        guard let request = draft.check.complaint(words: draft.words, report: draft.report) else {
            return nil
        }
        draft.sent = Press(request: request, life: life)
        drafts[ref] = draft
        return draft.sent
    }

    /// The sheet on `ref` closed: a draft he never wrote in or sent is dropped, so the next sheet opens on the card as it
    /// is then (the same ref may be another guess by then).
    public func close(_ ref: String) {
        guard let draft = drafts[ref], draft.sent == nil,
            draft.words.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        else { return }
        drafts[ref] = nil
    }

    /// Life's receipt `ask` for `press`: kept only while its draft still holds that press (a late one after a new
    /// pairing, or for an older press, changes nothing).
    public func received(_ ask: String, for press: Press) {
        guard drafts[press.request.ref]?.sent == press else { return }
        drafts[press.request.ref]?.receipt = ask
    }

    /// Another Life is paired: nothing of the last one's stays.
    public func clear() { drafts = [:] }
}
