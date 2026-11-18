import Glance
import SwiftUI
import WatchKit

@main
struct LifelogWatchApp: App {
    @WKApplicationDelegateAdaptor private var delegate: WatchDelegate

    var body: some Scene {
        WindowGroup {
            RemoteView()
                .environment(delegate.phone)
        }
    }
}

/// Owns the link from launch, so a background wake for the complication finds it listening.
final class WatchDelegate: NSObject, WKApplicationDelegate {
    let phone = PhoneLink.shared

    func handle(_ backgroundTasks: Set<WKRefreshBackgroundTask>) {
        for task in backgroundTasks {
            guard let connectivity = task as? WKWatchConnectivityRefreshBackgroundTask else {
                task.setTaskCompletedWithSnapshot(false)
                continue
            }
            // Done once WatchConnectivity has handed over what woke us (bounded, so the wake can't run away).
            Task {
                for _ in 0..<20 where phone.hasContentPending {
                    try? await Task.sleep(for: .milliseconds(500))
                }
                connectivity.setTaskCompletedWithSnapshot(false)
            }
        }
    }
}

/// A remote for the Pendant, through the iPhone: status and battery on top, then Record or Pause as one big control
/// showing the confirmed state. Sized for the smallest Watch, with no Crown needed.
/// A complication's tap lands here with what the face showed, and is sent at once.
struct RemoteView: View {
    @Environment(PhoneLink.self) private var phone

    var body: some View {
        // Redrawn when the evidence goes out of date, so it never reads fresher than it is.
        TimelineView(.explicit([Date.now] + (phone.glance?.changeDates ?? []))) { context in
            Remote(glance: phone.glance, now: context.date)
        }
        .containerBackground(Palette.bg.gradient, for: .navigation)
        .onOpenURL { url in
            if let request = RecordingGlance.Request(url: url) { Task { await phone.set(request) } }
        }
    }
}

private struct Remote: View {
    @Environment(PhoneLink.self) private var phone
    let glance: RecordingGlance?
    let now: Date

    var body: some View {
        ScrollView {
            VStack(spacing: 8) {
                if let glance {
                    StatusLine(glance: glance, now: now)
                }
                RecordingButton(glance: glance, now: now)
                Outcome(control: phone.control)
                if let sound = glance?.soundLine {
                    Text(sound).font(.footnote).foregroundStyle(.secondary)
                }
            }
        }
        // Felt, not just seen: the Pendant confirmed a new state, or something failed.
        .sensoryFeedback(.success, trigger: confirmed) { old, new in old != nil && new != nil && old != new }
        .sensoryFeedback(.error, trigger: phone.control) { _, new in
            if case .failed = new { true } else { false }
        }
    }

    /// What the Pendant last confirmed, while current.
    private var confirmed: RecordingGlance.Microphone? {
        if case .confirmed(let microphone, _) = glance?.reading(now: now) { microphone } else { nil }
    }
}

/// How we know, and the battery, in one line.
private struct StatusLine: View {
    let glance: RecordingGlance
    let now: Date

    var body: some View {
        HStack(spacing: 6) {
            StatusDot(state: glance.dot(now: now), size: 10)
            glance.evidence(now: now)
                .font(.system(.caption2, design: .monospaced))
                .foregroundStyle(.secondary)
                .lineLimit(2)
                .minimumScaleFactor(0.8)
            Spacer(minLength: 4)
            if let battery = glance.batteryLine(now: now) {
                let low = glance.batteryIsLow(now: now)
                Label(battery, systemImage: low ? "battery.25percent" : "battery.75percent")
                    .labelStyle(.titleAndIcon)
                    .font(.caption2.monospacedDigit())
                    .foregroundStyle(low ? Palette.flag : .secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(glance.sentence(now: now))
    }
}

/// The Pendant's state as the iPhone last knew it, and the tap that flips it. While a request waits it says so and
/// can't be pressed again; with nothing to send to it only says why.
private struct RecordingButton: View {
    @Environment(PhoneLink.self) private var phone
    let glance: RecordingGlance?
    let now: Date

    var body: some View {
        let request = waiting == nil ? glance?.toggle(now: now) : nil
        Button {
            if let request { Task { await phone.set(request) } }
        } label: {
            VStack(spacing: 2) {
                HStack(spacing: 6) {
                    if waiting != nil {
                        ProgressView().frame(width: 18, height: 18)
                    } else if let glance {
                        Image(systemName: glance.symbol(now: now))
                    }
                    Text(title)
                        .font(.system(.title3, design: .serif))
                        .lineLimit(1)
                        .minimumScaleFactor(0.6)
                }
                Text(caption(request))
                    .font(.caption2)
                    .opacity(0.8)
            }
            .frame(maxWidth: .infinity, minHeight: 54)
        }
        .buttonStyle(.glassProminent)
        .tint(
            glance?.microphone == .recording && glance?.connected == true ? Palette.flag : Color.white.opacity(0.16)
        )
        .disabled(request == nil)
    }

    /// Sent and not answered yet, or the iPhone says the Pendant hasn't confirmed.
    private var waiting: RecordingGlance.Request? {
        if case .sending(let request) = phone.control { return request }
        return glance?.pendingRequest(now: now)
    }

    private var title: String {
        if let waiting { return waiting == .pause ? "Pausing…" : "Resuming…" }
        return glance?.headline(now: now) ?? "No status yet"
    }

    private func caption(_ request: RecordingGlance.Request?) -> String {
        if waiting != nil { return "Waiting for the Pendant" }
        guard let glance else { return "Open lifelog on your iPhone" }
        return switch request {
        case .pause: "Tap to pause"
        case .resume: "Tap to record"
        case nil: glance.connected ? "Nothing to change" : "Pendant not connected"
        }
    }
}

/// What happened to the last pause or resume.
private struct Outcome: View {
    let control: PhoneLink.Control

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if case .failed(let reason) = control { Text(reason) }
        }
        .font(.footnote)
        .foregroundStyle(.secondary)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

#if DEBUG
    private func remote(_ link: PhoneLink) -> some View {
        NavigationStack { RemoteView() }.environment(link)
    }

    private let recording = RecordingGlance(
        connected: true, microphone: .recording, reportedAt: .now, currentUntil: .now + 300, battery: 82)

    #Preview("Recording") { remote(.preview(recording)) }
    #Preview("Paused") {
        remote(
            .preview(
                RecordingGlance(
                    connected: true, microphone: .paused, reportedAt: .now, currentUntil: .now + 300, battery: 18)))
    }
    #Preview("Out of reach") { remote(.preview(RecordingGlance(connected: false))) }
    #Preview("Never heard") { remote(.preview(nil)) }
    #Preview("Pause failed") {
        remote(.preview(recording, control: .failed("The Pendant didn't answer. Try again on the iPhone.")))
    }
#endif
