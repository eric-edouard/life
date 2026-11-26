import XCTest

// The P0 flows of `docs/research/2026-11-26-ios-e2e/test-map.md` that run on every push. Each asserts what the person
// sees and what Life was asked (one send per ask, one key per tap), never pixels.

/// S1: a pairing link, confirmed, signs in and opens the thread.
@MainActor final class S1PairByLinkTests: FlowTest {
    func testPairByLink() {
        launch("S1", paired: nil, open: Self.link("a", code: "ABC234"))
        tap(AID.pairConfirm)
        tap(AID.pairDone)
        appears(field, "the thread")
        let steps = calls().compactMap { ($0["authorize"] ?? $0["token"] ?? $0["tool"]) as? String }
        XCTAssertEqual(steps, ["approved", "issued", "read_thread"])
    }
}

/// S2: a wrong code pairs nothing, and the Life paired before still answers.
@MainActor final class S2BadPairingKeepsTheOldTests: FlowTest {
    func testBadPairingKeepsTheOld() {
        launch("S2", open: Self.link("b", code: "WRONG1"))
        tap(AID.pairConfirm)
        appears(element(AID.pairRetry), "Not paired")
        tap(AID.pairCancel)
        openTheAsk()
        XCTAssertTrue(
            calls().contains { $0["origin"] as? String == "a" && $0["tool"] as? String == "ask_main_session" })
        XCTAssertFalse(calls().contains { $0["origin"] as? String == "b" && $0["tool"] != nil })
    }
}

/// C1: Send on a draft: one call, one key, then the row is Settled.
@MainActor final class C1SendADraftTests: FlowTest {
    func testSendADraft() {
        launch("C1")
        sendTheListedDraft(shooting: "draft")
        XCTAssertEqual(answers().count, 1)
        XCTAssertFalse((answers()[0]["key"] as? String ?? "").isEmpty)
    }
}

/// C3: not sent says why and allows a retry, which is a new tap with a new key.
@MainActor final class C3NotSentTests: FlowTest {
    func testNotSent() {
        launch("C3")
        openTheAsk()
        tap(AID.askAnswer(Self.ask, "send"))
        appears(element(AID.askFailure(Self.ask)), "the reason it was not sent")
        tap(AID.askAnswer(Self.ask, "send"))
        appears(element(AID.askSettled(Self.ask)), "Settled")
        let keys = answers().compactMap { $0["key"] as? String }
        XCTAssertEqual(keys.count, 2)
        XCTAssertNotEqual(keys[0], keys[1])
        XCTAssertEqual(sends().count, 1)
    }
}

/// C5: the connection drops before the result: the retry repeats the same key and Life sends once.
@MainActor final class C5DroppedMidSendTests: FlowTest {
    func testDroppedMidSend() {
        launch("C5")
        openTheAsk()
        tap(AID.askAnswer(Self.ask, "send"))
        appears(element(AID.askSettled(Self.ask)), "Settled", within: 30)
        let keys = Set(answers().compactMap { $0["key"] as? String })
        XCTAssertEqual(answers().count, 2)
        XCTAssertEqual(keys.count, 1)
        XCTAssertEqual(sends().count, 1)
    }
}

/// C10: a settled iMessage send has no Undo.
@MainActor final class C10NoUndoOnAnIMessageTests: FlowTest {
    func testNoUndoOnAnIMessage() {
        launch("C10")
        sendTheListedDraft(shooting: "imessage-no-undo")
        unfold(element(AID.askRow(Self.ask)), until: app.staticTexts["Send Nora the message?"])
        appears(app.staticTexts["Send Nora the message?"], "the unfolded ask")
        XCTAssertFalse(element(AID.askUndo(Self.ask)).exists)
        XCTAssertEqual(answers().count, 1)
    }
}

/// C11: Undo asks what the other side will see, then Delete asks Life once to delete it.
@MainActor final class C11UndoThenDeleteTests: FlowTest {
    func testUndoThenDelete() {
        launch("C11")
        sendTheListedDraft(shooting: "undo-whatsapp")
        unfold(element(AID.askRow(Self.ask)), until: element(AID.askUndo(Self.ask)))
        // The thread redraws the row after each tap and it folds: each try unfolds it, asks, and confirms if it can.
        for _ in 0..<4 where undos().isEmpty {
            unfold(element(AID.askRow(Self.ask)), until: element(AID.askUndo(Self.ask)))
            element(AID.askUndo(Self.ask)).tap()
            let confirm = app.buttons["Delete for both"]
            if confirm.waitForExistence(timeout: 2) { confirm.tap() }
        }
        taps += 2
        poll("the undo reached Life") { !undos().isEmpty }
        XCTAssertEqual(undos().count, 1)
    }
}

/// C20: "How am I doing?" sits under the settled ask; his mark is one answer, and the row stays, saying "Thanks".
@MainActor final class C20RateTheAnswerTests: FlowTest {
    func testRateTheAnswer() {
        launch("C20")
        askLife()
        appears(element(AID.askRate(Self.ask, "good")), "How am I doing?")
        shoot("rate")
        // The thread fills the screen under the buttons: a thread squeezed to the bottom hid every earlier row.
        XCTAssertLessThan(app.scrollViews.firstMatch.frame.minY, app.frame.height / 4)
        tap(AID.askRate(Self.ask, "good"))
        poll("the mark reached Life") { !answers().isEmpty }
        XCTAssertEqual(answers().count, 1)
        XCTAssertEqual(answers()[0]["rate"] as? String, "good")
        appears(app.staticTexts["Thanks"], "Thanks")
    }
}

/// C12: an answer that takes a person sends the person he picked.
@MainActor final class C12PersonAsTheAnswerTests: FlowTest {
    func testPersonAsTheAnswer() {
        launch("C12")
        askLife("Text Ben that I’m running late")
        let row = element(AID.askRow(Self.ask))
        appears(row, "the ask in the thread")
        unfold(row, until: element(AID.askAnswer(Self.ask, "who")))
        tap(AID.askAnswer(Self.ask, "who"))
        let ben = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Ben Martin")).firstMatch
        appears(ben, "the people")
        shoot("which-person")
        ben.tap()
        poll("the answer reached Life") { !answers().isEmpty }
        XCTAssertEqual(answers().count, 1)
        XCTAssertEqual(answers()[0]["person"] as? String, "person:ben-martin")
        XCTAssertEqual(answers()[0]["options"] as? [String], ["who"])
    }
}

/// C16: an ask that goes outdated while open loses its answers: nothing can be sent.
@MainActor final class C16OutdatedWhileOpenTests: FlowTest {
    func testOutdatedWhileOpen() {
        launch("C16")
        openTheAsk()
        appears(element(AID.askAnswer(Self.ask, "send")), "Send")
        step(1)
        vanishes(element(AID.askAnswer(Self.ask, "send")), "Send gone once the ask is outdated")
        shoot("outdated")
        XCTAssertTrue(answers().isEmpty)
    }
}

/// O2: an answer with Life out of reach waits, sends nothing, and survives the app being closed.
@MainActor final class O2AnswerOfflineTests: FlowTest {
    func testAnswerOffline() {
        launch("O2")
        openTheAsk()
        appears(element(AID.askAnswer(Self.ask, "send")), "Send")
        step(1)
        appears(element(AID.noticeOutOfReach), "You're offline")
        tap(AID.askAnswer(Self.ask, "send"))
        appears(element(AID.askQueued(Self.ask)), "the answer waiting")
        app.terminate()
        launch("O2", paired: nil, reset: false)
        appears(element(AID.askQueued(Self.ask)), "the answer still waiting after a relaunch")
        appears(element(AID.noticeOutOfReach), "the notice again after a relaunch with Life out of reach")
        XCTAssertTrue(answers().isEmpty)
    }
}

/// O3: back in reach, the waiting answer goes once with its own saved key.
@MainActor final class O3FlushOnceTests: FlowTest {
    func testFlushOnce() {
        launch("O3")
        openTheAsk()
        appears(element(AID.askAnswer(Self.ask, "send")), "Send")
        step(1)
        appears(element(AID.noticeOutOfReach), "Your Mac isn't answering")
        tap(AID.askAnswer(Self.ask, "send"))
        appears(element(AID.askQueued(Self.ask)), "the answer waiting")
        step(2)
        appears(element(AID.noticeBack), "Back")
        XCTAssertEqual(element(AID.noticeBack).label, "Back online · 1 sent")
        XCTAssertEqual(answers().count, 1)
        XCTAssertFalse((answers()[0]["key"] as? String ?? "").isEmpty)
    }
}

/// O4: a waiting answer whose ask went out of date is dropped by Life, said as "Back" with nothing sent.
@MainActor final class O4FlushAfterOutdatedTests: FlowTest {
    func testFlushAfterOutdated() {
        launch("O4")
        openTheAsk()
        appears(element(AID.askAnswer(Self.ask, "send")), "Send")
        step(1)
        appears(element(AID.noticeOutOfReach), "Your Mac isn't answering")
        tap(AID.askAnswer(Self.ask, "send"))
        appears(element(AID.askQueued(Self.ask)), "the answer waiting")
        step(2)
        appears(element(AID.noticeBack), "Back")
        XCTAssertEqual(element(AID.noticeBack).label, "Back · caught up")
        XCTAssertEqual(answers().count, 1)
        XCTAssertTrue(sends().isEmpty)
        vanishes(element(AID.askQueued(Self.ask)), "the dropped answer gone")
    }
}

/// O7: an answer waiting for one Life is never sent to the Life paired next.
@MainActor final class O7QueueTiedToItsLifeTests: FlowTest {
    func testQueueTiedToItsLife() {
        launch("O7")
        openTheAsk()
        appears(element(AID.askAnswer(Self.ask, "send")), "Send")
        step(1)
        appears(element(AID.noticeOutOfReach), "Your Mac isn't answering")
        tap(AID.askAnswer(Self.ask, "send"))
        appears(element(AID.askQueued(Self.ask)), "the answer waiting")
        app.terminate()
        step(2)
        launch("O7", paired: nil, reset: false, open: Self.link("b", code: "XYZ789"))
        tap(AID.pairConfirm)
        tap(AID.pairDone)
        poll("Life B read") {
            calls().contains { $0["origin"] as? String == "b" && $0["tool"] as? String == "read_thread" }
        }
        // Life A, back at step 2, may take its own answer on the relaunch's read; Life B never gets it.
        XCTAssertFalse(answers().contains { $0["origin"] as? String == "b" })
    }
}

/// P1: a person's link opens their page, the ask about them live above Life's reading of them; a matter's link opens its
/// page, its ask by its question (never the matter's name again) above Life's reading of it. One read each, no model.
@MainActor final class P1PersonAndMatterPagesTests: FlowTest {
    func testPersonAndMatterPages() {
        launch("P1")
        askLife()
        let ana = app.links["Test Ana"]
        appears(ana, "the link to her")
        ana.tap()
        appears(text("you have known her since 2019"), "Life's reading of her")
        appears(element(AID.askRow(Self.ask)), "the ask about her")
        app.navigationBars.buttons.element(boundBy: 0).tap()
        let watch = app.links["the watch"]
        appears(watch, "the link to the matter")
        watch.tap()
        appears(text("Getting the watch repaired"), "Life's reading of the matter")
        appears(text("Send Kit the message?"), "its ask, by its question")
        let tools = calls().compactMap { $0["tool"] as? String }
        XCTAssertEqual(tools.filter { $0 == "read_matter" }.count, 1)
        XCTAssertEqual(tools.filter { $0 == "ask_main_session" }.count, 1)
    }

    private func text(_ words: String) -> XCUIElement {
        app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", words)).firstMatch
    }
}
