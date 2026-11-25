import SwiftUI

/// The notice at the top of the thread: "Your Mac isn't answering" while Life cannot be reached (it unfolds to the
/// phone's own settings), then, once, "Back" with how many of his answers went when it was.
struct Notices: View {
    @Environment(LifeStore.self) private var life
    let openSettings: () -> Void
    @State private var isOpen = false

    var body: some View {
        VStack(spacing: Metrics.Spacing.s) {
            if life.isOutOfReach {
                VStack(alignment: .leading, spacing: Metrics.Spacing.s) {
                    Button {
                        withAnimation(Motion.standard) { isOpen.toggle() }
                    } label: {
                        Text("Your Mac isn't answering").font(.rowName).frame(maxWidth: .infinity, alignment: .leading)
                            .frame(minHeight: Metrics.tapTarget).contentShape(.rect)
                    }
                    .buttonStyle(.plain).accessibilityIdentifier(AID.noticeOutOfReach)
                    if isOpen {
                        if let why = life.whyOutOfReach { Text(why).font(.note).foregroundStyle(Palette.muted) }
                        Button("Settings", action: openSettings).buttonStyle(.pill(.quiet, size: .compact))
                    }
                }
                .padding(.horizontal, Metrics.Spacing.l).card().transition(Motion.appears)
            } else if let back = life.caughtUp {
                Text(back.sent == 0 ? "Back" : "Back · \(back.sent) sent").font(.note).foregroundStyle(Palette.muted)
                    .accessibilityIdentifier(AID.noticeBack)
                    .task {
                        try? await Task.sleep(for: .seconds(4))
                        life.clearCaughtUp()
                    }
            }
        }
        .animation(Motion.standard, value: life.isOutOfReach)
    }
}
