import LifeConnector
import MacLink
import ServerAPI
import SwiftUI

/// A pairing link the owner is asked to confirm: the lifelog server, Life, or both. A link could come from anywhere, so
/// nothing is kept until he says so in `PairSheet`.
struct PairOffer: Identifiable {
    let id = UUID()
    private let link: PairLink
    var server: Pairing? { link.server }
    var life: LifePairing? { link.life }

    init?(link: URL) {
        guard let link = PairLink(link: link) else { return nil }
        self.link = link
    }

    var connections: [Connection] { [life == nil ? nil : .life, server == nil ? nil : .server].compactMap(\.self) }

    func address(of connection: Connection) -> String {
        (connection == .life ? life?.origin : server?.server)?.addressWords ?? ""
    }
}

extension URL {
    /// A server as the owner reads it: its host, and its port when it isn't the usual one.
    var addressWords: String { [host(), port.map(String.init)].compactMap(\.self).joined(separator: ":") }
}

/// Pairing as a sheet, entered only through `onOpenURL` (the Camera opens the link; Settings' paste goes the same way):
/// confirm what it names, then the checks as they run, then Paired, or Not paired with the reason. A server's token is
/// checked before it is kept and Life's tokens are kept once it approved, so a failed pairing leaves the old one working.
struct PairSheet: View {
    let offer: PairOffer
    @Binding var isPairing: Bool
    @Environment(SyncStore.self) private var sync
    @Environment(LifeStore.self) private var life
    @Environment(\.dismiss) private var dismiss

    private enum Phase { case confirming, pairing, done }

    /// How far one connection's pairing got: the lines passed, and where and why it failed.
    private struct Run {
        var passed = 1
        var failedAt: Int?
        var reason: String?
        var isKept = false
    }

    @Environment(\.dynamicTypeSize) private var size
    @State private var phase = Phase.confirming
    @State private var runs: [Connection: Run] = [:]

    var body: some View {
        VStack(alignment: .leading, spacing: Metrics.Spacing.xl) {
            if phase == .confirming { confirm } else { progress }
            // At the accessibility sizes the buttons scroll with the words, so none hides under them.
            if size.isAccessibilitySize { VStack(spacing: Metrics.Spacing.m) { buttons } }
        }
        // The body changes only between asking and checking: pairing to done changes its lines in place.
        .faces(phase == .confirming)
        .sheetScroll {
            SheetHeader(title: title, close: { dismiss() })
        } buttons: {
            if !size.isAccessibilitySize { VStack(spacing: Metrics.Spacing.m) { buttons }.faces(phase) }
        }
        .readingWidth()
        .background(Palette.sheet)
        .presentationBackground(Palette.sheet)
        .interactiveDismissDisabled(phase == .pairing)
        .onChange(of: phase) { isPairing = phase == .pairing }
        .onDisappear { isPairing = false }
    }

    private var title: String {
        switch phase {
        case .confirming: "Pair"
        case .pairing: "Pairing"
        case .done: runs.values.allSatisfy(\.isKept) ? "Paired" : "Not paired"
        }
    }

    // MARK: Confirm

    private var confirm: some View {
        VStack(alignment: .leading, spacing: Metrics.Spacing.l) {
            RowGroup(surface: .sheet) {
                ForEach(offer.connections) { connection in
                    Row(title: connection.name) {
                        Text(offer.address(of: connection)).font(.line).foregroundStyle(Palette.muted)
                    }
                }
            }
            if let replaced {
                Text(replaced).font(.line).foregroundStyle(Palette.muted).fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    /// What this pairing replaces, naming where the phone sends now: a link never repoints the app unseen.
    private var replaced: String? {
        let now = [
            offer.life.flatMap { _ in life.pairedOrigin.map { "Life at \($0.addressWords)" } },
            offer.server.flatMap { _ in sync.server.map { "the server at \($0.addressWords)" } },
        ].compactMap(\.self)
        guard !now.isEmpty else { return nil }
        return
            "This replaces the pairing this phone has now: \(now.joined(separator: " and ")). Pair only if it moved to the address above."
    }

    // MARK: Checks

    @ViewBuilder private var progress: some View {
        ForEach(offer.connections) { connection in
            let multiple = offer.connections.count > 1
            RowGroup(label: multiple ? connection.name : nil, surface: .sheet) {
                CheckLines(lines: lines(connection)).padding(Metrics.Spacing.l).frame(
                    maxWidth: .infinity, alignment: .leading)
            }
        }
        if phase == .done {
            ForEach(offer.connections) { connection in
                if let reason = runs[connection]?.reason {
                    Text(
                        reason
                            + (runs[connection]?.isKept == false && hadPairing(connection)
                                ? " Your old pairing still works." : "")
                    )
                    .font(.line).foregroundStyle(Palette.muted).fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    private func hadPairing(_ connection: Connection) -> Bool {
        connection == .life ? life.isPaired : sync.isPaired
    }

    private func lines(_ connection: Connection) -> [CheckLine] {
        let run = runs[connection] ?? Run()
        // A step that failed says so (its reason is under the lines); one that passed or waits says what it checks.
        let host = connection == .life ? "Mac" : "server"
        var words =
            connection == .life
            ? ["The link is valid", "The Mac accepts this phone", "Your thread reads"]
            : ["The link is valid", "The server accepts this phone"]
        if let failed = run.failedAt, words.indices.contains(failed) {
            words[failed] =
                ["The link did not work", "The \(host) did not accept this phone", "Your thread did not read"][
                    failed]
        }
        return CheckLine.lines(
            connection.id, words, passed: run.passed, failedAt: run.failedAt, isRunning: phase == .pairing)
    }

    // MARK: Buttons

    @ViewBuilder private var buttons: some View {
        switch phase {
        case .confirming:
            Button("Pair this phone") { Task { await pair() } }.buttonStyle(.pill(.filled))
                .accessibilityIdentifier(AID.pairConfirm)
            Button("Cancel") { dismiss() }.buttonStyle(.pill(.quiet))
        case .pairing:
            Button("Pairing…") {}.buttonStyle(.pill(.filled, isBusy: true))
        case .done where runs.values.allSatisfy(\.isKept):
            Button("Done") { dismiss() }.buttonStyle(.pill(.filled)).accessibilityIdentifier(AID.pairDone)
        case .done:
            Button("Try again") { Task { await pair() } }.buttonStyle(.pill(.filled)).accessibilityIdentifier(
                AID.pairRetry)
            Button("Cancel") { dismiss() }.buttonStyle(.pill(.quiet)).accessibilityIdentifier(AID.pairCancel)
        }
    }

    // MARK: Pairing

    private func pair() async {
        phase = .pairing
        runs = [:]
        for connection in offer.connections {
            runs[connection] = Run()
            let step = { (step: PairStep) in
                runs[connection]?.passed = step == .accepting ? 1 : 2
                return
            }
            do {
                switch connection {
                case .life: if let link = offer.life { try await life.pair(link, onStep: step) }
                case .server: if let link = offer.server { try await sync.pair(link, onStep: step) }
                }
                runs[connection]?.isKept = true
                runs[connection]?.passed = connection == .life ? 3 : 2
                if connection == .life { checkInbox() }
            } catch {
                let failure = ConnectionCheck.failure(error)
                runs[connection]?.failedAt = failure.isLink ? 0 : runs[connection]?.passed
                runs[connection]?.reason = failure.reason
            }
        }
        phase = .done
    }

    /// Paired, but the inbox is the first proof: if it did not read, its line fails with why.
    private func checkInbox() {
        if life.items.value == nil || life.outcome != .works {
            runs[.life]?.failedAt = 2
            runs[.life]?.reason = ConnectionCheck.reason(.life, life.outcome)
        }
    }
}
