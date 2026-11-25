import XCTest

// The P0 flows of `docs/research/2026-11-26-ios-e2e/test-map.md` that run on every push. Each asserts what the person
// sees and what Life was asked (one send per ask, one key per tap), never pixels.

/// S1: a pairing link, confirmed, signs in and opens the thread.
final class S1PairByLinkTests: FlowTest {
    func testPairByLink() {
        launch("S1", paired: nil, open: Self.link("a", code: "ABC234"))
        tap(AID.pairConfirm)
        tap(AID.pairDone)
        appears(app.buttons["What's waiting on me"], "the thread")
        let tools = calls().map { ($0["authorize"] ?? $0["token"] ?? $0["tool"]) as? String ?? "" }
        XCTAssertEqual(tools.prefix(2), ["approved", "issued"])
        XCTAssertTrue(tools.contains("read_thread"))
    }
}

/// S2: a wrong code pairs nothing, and the Life paired before still answers.
final class S2BadPairingKeepsTheOldTests: FlowTest {
    func testBadPairingKeepsTheOld() {
        launch("S2", open: Self.link("b", code: "WRONG1"))
        tap(AID.pairConfirm)
        appears(element(AID.pairRetry), "Not paired")
        tap(AID.pairCancel)
        openTheAsk()
        XCTAssertTrue(calls().contains { $0["origin"] as? String == "a" && $0["tool"] as? String == "ask_main_session" })
        XCTAssertFalse(calls().contains { $0["origin"] as? String == "b" && $0["tool"] != nil })
    }
}

/// C1: Send on a draft: one call, one key, then the row is Settled.
final class C1SendADraftTests: FlowTest {
    func testSendADraft() {
        launch("C1")
        openTheAsk()
        tap(AID.askAnswer(Self.ask, "send"))
        appears(element(AID.askSettled(Self.ask)), "Settled")
        XCTAssertEqual(answers().count, 1)
        XCTAssertFalse((answers()[0]["key"] as? String ?? "").isEmpty)
    }
}

/// C3: not sent says why and allows a retry, which is a new tap with a new key.
final class C3NotSentTests: FlowTest {
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
final class C5DroppedMidSendTests: FlowTest {
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
final class C10NoUndoOnAnIMessageTests: FlowTest {
    func testNoUndoOnAnIMessage() {
        launch("C10")
        openTheAsk()
        appears(element(AID.askSettled(Self.ask)), "Settled")
        appears(app.staticTexts["Send Kit the message?"], "the unfolded ask")
        XCTAssertFalse(element(AID.askUndo(Self.ask)).exists)
        XCTAssertTrue(answers().isEmpty)
    }
}

/// C16: an ask that goes outdated while open loses its answers: nothing can be sent.
final class C16OutdatedWhileOpenTests: FlowTest {
    func testOutdatedWhileOpen() {
        launch("C16")
        openTheAsk()
        appears(element(AID.askAnswer(Self.ask, "send")), "Send")
        step(1)
        appears(element(AID.askOutdated(Self.ask)), "the ask outdated")
        XCTAssertFalse(element(AID.askAnswer(Self.ask, "send")).exists)
        XCTAssertTrue(answers().isEmpty)
    }
}

/// O2: an answer with Life out of reach waits, sends nothing, and survives the app being closed.
final class O2AnswerOfflineTests: FlowTest {
    func testAnswerOffline() {
        launch("O2")
        openTheAsk()
        appears(element(AID.askAnswer(Self.ask, "send")), "Send")
        step(1)
        appears(element(AID.noticeOutOfReach), "Your Mac isn't answering")
        tap(AID.askAnswer(Self.ask, "send"))
        appears(element(AID.askQueued(Self.ask)), "the answer waiting")
        app.terminate()
        launch("O2", paired: nil, reset: false)
        appears(element(AID.askQueued(Self.ask)), "the answer still waiting after a relaunch")
        XCTAssertTrue(answers().isEmpty)
    }
}

/// O3: back in reach, the waiting answer goes once with its own saved key.
final class O3FlushOnceTests: FlowTest {
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
        XCTAssertEqual(element(AID.noticeBack).label, "Back · 1 sent")
        XCTAssertEqual(answers().count, 1)
        XCTAssertFalse((answers()[0]["key"] as? String ?? "").isEmpty)
    }
}

/// O4: a waiting answer whose ask went out of date is dropped by Life, said as "Back" with nothing sent.
final class O4FlushAfterOutdatedTests: FlowTest {
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
        XCTAssertEqual(element(AID.noticeBack).label, "Back")
        XCTAssertEqual(answers().count, 1)
        XCTAssertTrue(sends().isEmpty)
        vanishes(element(AID.askQueued(Self.ask)), "the dropped answer gone")
    }
}

/// O7: an answer waiting for one Life is never sent to the Life paired next.
final class O7QueueTiedToItsLifeTests: FlowTest {
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
        poll("Life B read") { calls().contains { $0["origin"] as? String == "b" && $0["tool"] as? String == "read_thread" } }
        appears(element(AID.noticeBack), "Back")
        XCTAssertTrue(answers().isEmpty)
    }
}
