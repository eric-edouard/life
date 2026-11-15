import Library
import ServerAPI
import SwiftUI

/// "Who's this?": the voices to name, one at a time, in the server's order. The question, when and how much they talked
/// with the owner, why the app asks, and their clips as words to read that play one after another; then one answer and
/// the next voice.
struct NamingView: View {
    @Environment(NamingQueue.self) private var queue
    @Environment(PlaybackStore.self) private var playback
    @Environment(\.dismiss) private var dismiss
    /// Answered on this visit, for "3 of 6".
    @State private var answered = 0

    var body: some View {
        ZStack {
            Palette.ground.ignoresSafeArea()
            if let voice = queue.next {
                VoicePage(voice: voice, people: queue.people) { answer in
                    reply(voice, answer)
                } name: {
                    queue.name($0, as: $1)
                } skip: {
                    queue.skip(voice)
                }
                .id(voice.id)
                .transition(.asymmetric(insertion: .move(edge: .trailing), removal: .move(edge: .leading)))
            } else if queue.loaded {
                CaughtUp { dismiss() }
                    .transition(.opacity)
            } else {
                ProgressView("Finding voices")
                    .foregroundStyle(Palette.textSecondary)
            }
        }
        .motion(Motion.rise, value: queue.next?.id)
        .navigationTitle(progress)
        .navigationBarTitleDisplayMode(.inline)
        .sensoryFeedback(.success, trigger: answered) { old, new in new > old }
        .onAppear { playback.pagesOnScreen += 1 }
        .onDisappear { playback.pagesOnScreen -= 1 }
        .task { await queue.refresh() }
        // The next voice's audio is rebuilt while the owner listens to this one.
        .task(id: queue.upcoming.map(\.id)) {
            for voice in queue.upcoming { await queue.prepare(voice) }
        }
        .alert("Couldn’t save that answer", item: Bindable(queue).actionError) { _ in
            Button("OK") {}
        } message: { error in
            Text(error)
        }
    }

    /// "2 of 6", or nothing once every voice is named.
    private var progress: String {
        queue.voices.isEmpty ? "" : "\(answered + 1) of \(answered + queue.voices.count)"
    }

    private func reply(_ voice: NamingQueue.Voice, _ answer: ServerClient.NamingAnswer) {
        if playback.isPlaying { playback.pause() }
        withMotion(Motion.rise) {
            queue.answer(voice, with: answer)
            answered += 1
        }
    }
}

extension NamingQueue {
    /// The voice to ask about now.
    var next: Voice? { voices.first }

    /// The next two voices, whose audio is made ready ahead.
    var upcoming: ArraySlice<Voice> { voices.prefix(2) }
}
