#if DEBUG
    import Foundation
    import ServerAPI

    /// `-fixtureDictation <state>` puts every dictation field on screen in one state of the spec of 22 Nov, for
    /// `design:shots` (no microphone, no Mac): `listening` (a run whose level speaks), `holding` (held, the chevron over
    /// the microphone), `armed` (slid up past the mark), `writing` (stopped, the words never come), `sending` (stopped by
    /// Send) and `failed` (the words could not be written).
    @MainActor enum DictationFixture {
        static let state: String? = {
            let arguments = ProcessInfo.processInfo.arguments
            return arguments.firstIndex(of: "-fixtureDictation").flatMap {
                arguments.indices.contains($0 + 1) ? arguments[$0 + 1] : nil
            }
        }()

        /// Drives the field's run into the state asked; false when none was (the field goes on as usual).
        static func drive(_ dictation: Dictation, start: () -> Void) -> Bool {
            guard let state else { return false }
            dictation.begin = { _ in
                let opened = Date.now
                return DictationRun(
                    level: { Float(0.02 + 0.06 * abs(sin(Date.now.timeIntervalSince(opened) * 5))) },
                    finish: {
                        if state == "failed" { throw CancellationError() }
                        try await Task.sleep(for: .seconds(3_600))
                        return Data()
                    })
            }
            start()
            Task {
                try? await Task.sleep(for: .seconds(2))
                switch state {
                case "writing", "failed": dictation.pause()
                case "sending": dictation.send()
                default: break
                }
            }
            return true
        }

        /// The microphone's touch for `holding` and `armed`.
        static func press(canSend: Bool) -> DictationPress? {
            guard state == "holding" || state == "armed" else { return nil }
            var press = DictationPress(canSend: canSend)
            _ = press.press(at: 0, isRunning: true)
            press.held(since: 0)
            if state == "armed" { press.move(up: 64) }
            return press
        }
    }
#endif
