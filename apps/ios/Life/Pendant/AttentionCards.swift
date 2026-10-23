import Incidents
import PendantProtocol
import SwiftUI

/// A calm card for something that needs the owner: what happened, the known reason, and the way out. Only shown
/// while it holds, so an empty screen means nothing is waiting.
struct AttentionCard<Actions: View>: View {
    /// A stable `accessibilityIdentifier` ("pendant.card.approval") for UI flows.
    let id: String
    let title: String
    let systemImage: String
    let detail: String
    /// A small line under the detail for reference numbers the owner rarely needs.
    var footnote: String?
    let actions: Actions

    init(
        id: String, title: String, systemImage: String, detail: String, footnote: String? = nil,
        @ViewBuilder actions: () -> Actions
    ) {
        self.id = id
        self.title = title
        self.systemImage = systemImage
        self.detail = detail
        self.footnote = footnote
        self.actions = actions()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label {
                // On the title: the card's own container never reaches the native tree; its title does.
                WholeWords(title)
                    .accessibilityIdentifier(id)
            } icon: {
                Image(systemName: systemImage)
                    .foregroundStyle(Palette.redText)
                    .accessibilityHidden(true)
            }
            .font(.headline)
            .foregroundStyle(Palette.textPrimary)
            .accessibilityAddTraits(.isHeader)
            Text(detail)
                .font(.subheadline)
                .foregroundStyle(Palette.textBody)
                .fixedSize(horizontal: false, vertical: true)
            if let footnote {
                Text(footnote)
                    .font(.caption)
                    .foregroundStyle(Palette.textTertiary)
            }
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 8) { actions }
                VStack(alignment: .leading, spacing: 8) { actions }
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .card(radius: Metrics.Radius.group)
        .transition(.blurReplace.combined(with: .scale(0.97)))
    }
}

extension AttentionCard where Actions == EmptyView {
    init(id: String, title: String, systemImage: String, detail: String) {
        self.init(id: id, title: title, systemImage: systemImage, detail: detail) { EmptyView() }
    }
}

/// Conditions the status sentence doesn't already say, each with its one way out.
struct ConditionCards: View {
    let conditions: [CaptureCondition]
    let perform: (Recovery) -> Void

    var body: some View {
        ForEach(conditions, id: \.title) { condition in
            AttentionCard(
                id: condition.cardID, title: condition.title, systemImage: condition.systemImage,
                detail: condition.detail
            ) {
                if let recovery = condition.recovery {
                    Button(recovery.title) { perform(recovery) }
                        .buttonStyle(.glass)
                        .accessibilityIdentifier("\(condition.cardID).action")
                }
            }
        }
    }
}

extension CaptureCondition {
    /// "pendant.card.staleTelemetry": the condition's name, the same whatever it carries.
    var cardID: String { "pendant.card." + String(describing: self).prefix { $0 != "(" } }

    /// Shown as a card rather than in the status sentence: the sentence covers what keeps Life from the Pendant,
    /// checking, being out of reach, and a pause or resume that didn't take.
    var isCard: Bool {
        switch self {
        case .checking, .outOfReach, .recordingControlFailed: false
        default: !blocksLink
        }
    }
}

/// An Omi whose firmware frees audio from the pendant as soon as the phone receives it (`OmiFirmware`): the owner
/// accepted the risk on Oct 22 and the user is told it plainly, with the update once one exists (`docs/voice/pendant.md`).
struct OmiCustodyCard: View {
    let revision: String?

    var body: some View {
        AttentionCard(
            id: "pendant.card.omiCustody", title: "This Omi deletes audio once it's sent",
            systemImage: "exclamationmark.triangle", detail: detail, footnote: revision.map { "Omi firmware \($0)" }
        ) { EmptyView() }
    }

    private var detail: String {
        let risk =
            "Its firmware deletes audio from the Omi as soon as the phone receives it, before Life has saved it. If the phone dies or quits mid-transfer, that audio is lost."
        guard let fixed = OmiFirmware.custodyFixedIn else { return risk + " An Omi firmware update will fix this." }
        let version = fixed.map(String.init).joined(separator: ".")
        return risk + " Firmware \(version) fixes it: update it in the Omi app, under Device Settings."
    }
}

/// Asks for notifications only after saying what they're for, once a Pendant is known; never at launch.
struct NotificationsInvite: View {
    let allow: () -> Void
    let dismiss: () -> Void

    var body: some View {
        AttentionCard(
            id: "pendant.card.notifications", title: "Get told when it matters", systemImage: "bell.badge",
            detail:
                "Life can tell you once when recording stops on its own, the Pendant's battery runs low, or it's out of reach for a while. Nothing about what you do here."
        ) {
            Button("Allow notifications", action: allow)
                .primaryGlassButton()
                .accessibilityIdentifier("pendant.card.notifications.allow")
            Button("Not now", action: dismiss)
                .buttonStyle(.glass)
                .accessibilityIdentifier("pendant.card.notifications.dismiss")
        }
    }
}
