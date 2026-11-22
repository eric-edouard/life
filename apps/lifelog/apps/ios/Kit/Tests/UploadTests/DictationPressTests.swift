import ServerAPI
import Testing

@Test func aTapStartsARunAndKeepsItGoingAndTheNextTapStopsIt() {
    var press = DictationPress(canSend: true)
    #expect(press.press(at: 0, isRunning: false) == .start)
    #expect(press.release(at: 0.1) == nil, "the run keeps going: tap to talk")
    #expect(press.press(at: 2, isRunning: true) == nil)
    #expect(press.release(at: 2.1) == .stop)
}

@Test func aHoldTalksWhileHeldAndLettingGoStops() {
    var press = DictationPress(canSend: true)
    #expect(press.press(at: 0, isRunning: false) == .start)
    press.held(since: 0)
    #expect(press.isHolding)
    #expect(press.release(at: 1.5) == .stop, "the words land, nothing is sent")
    #expect(!press.isDown && !press.isHolding)
}

@Test func aLateTimerFromAnEarlierTouchNeverMakesAHold() {
    var press = DictationPress(canSend: true)
    _ = press.press(at: 0, isRunning: false)
    _ = press.release(at: 0.1)
    _ = press.press(at: 0.2, isRunning: true)
    press.held(since: 0)
    #expect(!press.isHolding)
}

@Test func aHoldSlidUpPastTheMarkSendsAndBackUnderItDoesNot() {
    var press = DictationPress(canSend: true)
    _ = press.press(at: 0, isRunning: false)
    press.held(since: 0)
    press.move(up: 50)
    #expect(!press.isArmed)
    press.move(up: 60)
    #expect(press.isArmed)
    press.move(up: 50)
    #expect(press.isArmed, "no chatter: it disarms under 44 only")
    press.move(up: 30)
    #expect(!press.isArmed)
    #expect(press.release(at: 1) == .stop)

    _ = press.press(at: 2, isRunning: false)
    press.held(since: 2)
    press.move(up: 80)
    #expect(press.release(at: 3) == .send)
}

@Test func onlyAHoldWithASendArms() {
    var tap = DictationPress(canSend: true)
    _ = tap.press(at: 0, isRunning: true)
    tap.move(up: 90)
    #expect(!tap.isArmed, "a flick is a tap, never a send")
    var noSend = DictationPress(canSend: false)
    _ = noSend.press(at: 0, isRunning: false)
    noSend.held(since: 0)
    noSend.move(up: 90)
    #expect(!noSend.isArmed)
    #expect(noSend.release(at: 1) == .stop)
}

@Test func theMicrophoneFollowsTheThumbThenResists() {
    var press = DictationPress(canSend: true)
    _ = press.press(at: 0, isRunning: false)
    press.held(since: 0)
    press.move(up: 40)
    #expect(press.lift == 40)
    press.move(up: 86)
    #expect(press.lift == 66)
    press.move(up: -20)
    #expect(press.lift == 0)
}

@Test func anAccidentalTouchTheSystemTakesDropsItsRunAndNeverStopsAnother() {
    var press = DictationPress(canSend: true)
    _ = press.press(at: 0, isRunning: false)
    #expect(press.takenAway() == .cancel, "a scroll that began on the microphone writes nothing")
    _ = press.press(at: 1, isRunning: true)
    #expect(press.takenAway() == .stop)
    _ = press.press(at: 2, isRunning: false)
    press.held(since: 2)
    #expect(press.takenAway() == .stop, "what he said while holding lands")
    #expect(press.takenAway() == nil)
    #expect(press.release(at: 3) == nil)
}
