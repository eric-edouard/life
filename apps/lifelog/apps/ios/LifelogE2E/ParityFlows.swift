import XCTest

// The flows that reach a state of the approved prototype over its own made-up data (`fixtures/wire/parity/`), for the
// parity board (`bun run parity`): each shoots its row. The other parity rows are shot inside their flows of `Flows.swift`.

/// OP1, clean: the opening screen after five minutes away: Hi Sam, three asks and "2 more".
@MainActor final class OP1OpeningCleanTests: FlowTest {
    func testOpeningClean() {
        launch("OP1")
        appears(field, "the thread")
        appears(
            app.buttons.matching(NSPredicate(format: "label ENDSWITH %@", "waiting on you")).firstMatch, "the count")
        shoot("open-clean")
    }
}

/// OP1, broken: the same opening, LINE and Messenger signed Life out, their two fixes above the asks.
@MainActor final class OP1OpeningBrokenTests: FlowTest {
    func testOpeningBroken() {
        launch("OP1")
        appears(field, "the thread")
        step(1)
        appears(app.staticTexts["Sign LINE back in"], "the fix for LINE")
        appears(app.staticTexts["Sign Messenger back in"], "the fix for Messenger")
        shoot("open-broken")
    }
}

/// W1: the round count's tap lists what waits on him in the thread, with no call to Life.
@MainActor final class W1WaitingListTests: FlowTest {
    func testWaitingList() {
        launch("W1")
        appears(field, "the thread")
        openWaiting()
        appears(app.staticTexts["Call the bank"], "the last of what waits")
        shoot("waiting")
        XCTAssertFalse(calls().contains { $0["tool"] as? String == "ask_main_session" })
    }
}

/// O2: the phone goes offline at the opening: the thread stays, one notice says what waits.
@MainActor final class O2OfflineNoticeTests: FlowTest {
    func testOfflineNotice() {
        launch("O2")
        appears(field, "the thread")
        step(1)
        poll("You're offline") { element(AID.noticeOutOfReach).label.hasPrefix("You're offline") }
        shoot("offline")
    }
}

/// L5: Life stops answering: the thread stays, one notice says why, and nothing is lost.
@MainActor final class L5MacOutOfReachTests: FlowTest {
    func testMacOutOfReach() {
        launch("L5")
        appears(field, "the thread")
        step(1)
        appears(element(AID.noticeOutOfReach), "Your Mac isn't answering")
        shoot("mac-out")
    }
}

/// N1: WhatsApp signed Life out: the opening puts its fix row first, to sign back in.
@MainActor final class N1SignBackInTests: FlowTest {
    func testSignBackIn() {
        launch("N1")
        appears(field, "the thread")
        appears(app.staticTexts["Sign WhatsApp back in"], "the signed-out row")
        shoot("signed-out")
    }
}

/// M1: an answer arrives as it is written, its words a few at a time, then what hasn't moved.
@MainActor final class M1SlowAnswerTests: FlowTest {
    func testSlowAnswer() {
        launch("M1")
        askLife("Where are we regarding the house?")
        appears(
            app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "The rest hasn’t moved")).firstMatch,
            "the answer's last words", within: 30)
        shoot("slow-answer")
    }
}

/// V1: the voices row opened on a voice Life suggests someone for: the moment, Life's reason, its answers.
@MainActor final class V1VoiceGuessTests: FlowTest {
    func testVoiceGuess() {
        launch("W1")
        let more = app.buttons.matching(NSPredicate(format: "label ENDSWITH %@", " more")).firstMatch
        appears(more, "the rest of the rows")
        more.tap()
        taps += 1
        unfold(element(AID.askRow("voices")), until: element(AID.voicesAnswer("is-them")))
        appears(app.staticTexts["You called Clara at 14:20, and this voice is on that call."], "Life's reason")
        shoot("voice-guess")
    }
}
