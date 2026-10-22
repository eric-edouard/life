import AppKit
import SwiftUI

/// The menu-bar panel under Life's L: how Life stands at a glance (the parts in trouble, the night, the memory, the
/// tasks, the engine, the last 24 hours) and its few actions.
struct Panel: View {
  let supervisor: Supervisor
  let openSettings: () -> Void
  let openStatus: () -> Void
  @State private var code: String?

  /// The parts the panel shows at a glance, when the plate has them.
  private static let glance = ["nightly", "memory", "tasks", "engine"]

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      if supervisor.info?.started == true {
        header
        if let plate = supervisor.plate {
          rows(plate.troubled + Self.glance.compactMap { id in
            plate.cards.first { $0.id == id && !plate.trouble.contains(id) }
          })
          VStack(alignment: .leading, spacing: 8) {
            Text("24 h").font(Ledger.mono(10.5, .medium)).textCase(.uppercase).kerning(0.8)
              .foregroundStyle(Ledger.muted)
            DayStrip(ticks: plate.today, now: plate.observedAt, height: 26)
          }
          .padding(16)
        } else {
          Text("Not answering").font(Ledger.serif(14)).foregroundStyle(Ledger.muted).padding(16)
        }
        actions
      } else {
        Text("Not set up").font(Ledger.serif(16, .semibold)).padding(16)
      }
      menu
    }
    .frame(width: 360)
    .background(Ledger.page)
    .foregroundStyle(Ledger.ink)
    .onAppear { Task { await supervisor.refresh() } }
  }

  private var header: some View {
    HStack(spacing: 10) {
      Text("L").font(.custom("Source Serif 4", size: 21).weight(.bold).italic())
        .foregroundStyle(Ledger.page)
        .frame(width: 30, height: 30)
        .background(Ledger.ink, in: .rect(cornerRadius: 7))
        .accessibilityHidden(true)
      Text("Life").font(Ledger.serif(17, .semibold))
      Spacer()
      if let plate = supervisor.plate {
        let n = plate.troubled.count
        Pill(tone: n == 0 ? .ok : plate.worst == .bad ? .bad : .warn, word: n == 0 ? "ok" : "\(n) to look at")
      } else {
        Pill(tone: .idle, word: "off")
      }
    }
    .padding(16)
  }

  /// The parts in trouble first, then the ones at a glance, one ruled row each.
  private func rows(_ cards: [Card]) -> some View {
    VStack(alignment: .leading, spacing: 0) {
      ForEach(Array(cards.enumerated()), id: \.element.id) { i, card in
        Button(action: openStatus) {
          HStack(spacing: 10) {
            Circle().fill(card.tone.color).frame(width: 7, height: 7)
            VStack(alignment: .leading, spacing: 1) {
              Text(card.name).font(Ledger.serif(14, .semibold)).lineLimit(1)
              if card.headline != card.word {
                Text(card.headline).font(Ledger.serif(12.5)).foregroundStyle(Ledger.muted).lineLimit(1)
              }
            }
            Spacer()
            Pill(tone: card.tone, word: card.word)
          }
          .padding(.horizontal, 14)
          .padding(.vertical, 9)
          .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .overlay(alignment: .top) { Rectangle().fill(i == 0 ? .clear : Ledger.line).frame(height: 1) }
      }
    }
    .background(Ledger.panel, in: .rect(cornerRadius: 9))
    .overlay { RoundedRectangle(cornerRadius: 9).strokeBorder(Ledger.line) }
    .padding(.horizontal, 12)
  }

  private var actions: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(spacing: 8) {
        Button(action: openStatus) {
          Text("Status").frame(maxWidth: .infinity).padding(.vertical, 7)
            .background(Ledger.ink, in: .rect(cornerRadius: 6)).foregroundStyle(Ledger.page)
        }
        Button {
          Task { code = await Helper.run(["pair"]).out.trimmingCharacters(in: .whitespacesAndNewlines) }
        } label: {
          Text("Pair an app").frame(maxWidth: .infinity).padding(.vertical, 7)
            .background(Ledger.panel, in: .rect(cornerRadius: 6))
            .overlay { RoundedRectangle(cornerRadius: 6).strokeBorder(Ledger.line) }
        }
      }
      .buttonStyle(.plain)
      .font(Ledger.serif(13.5, .semibold))
      if let code {
        HStack {
          Text(code).font(Ledger.mono(13, .medium)).textSelection(.enabled)
          Spacer()
          Text("5 min").font(Ledger.mono(11)).foregroundStyle(Ledger.muted)
        }
      }
    }
    .padding(.horizontal, 16)
    .padding(.bottom, 14)
  }

  private var menu: some View {
    VStack(spacing: 0) {
      if let report = supervisor.info?.lastReport {
        MenuRow("Last report") { NSWorkspace.shared.open(URL(fileURLWithPath: report)) }
      }
      if let updates {
        MenuRow("Updates…") { updates.checkForUpdates(nil) }
      }
      MenuRow("Settings…", action: openSettings)
      MenuRow("Quit") {
        supervisor.stop()
        NSApp.terminate(nil)
      }
    }
    .padding(6)
    .overlay(alignment: .top) { Rectangle().fill(Ledger.line).frame(height: 1) }
  }
}

/// A menu item in the panel: highlighted under the pointer, like a menu's.
private struct MenuRow: View {
  let title: String
  let action: () -> Void
  @State private var hover = false

  init(_ title: String, action: @escaping () -> Void) {
    self.title = title
    self.action = action
  }

  var body: some View {
    Button(action: action) {
      Text(title).font(Ledger.serif(14))
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 10)
        .padding(.vertical, 5)
        .foregroundStyle(hover ? Color.white : Ledger.ink)
        .background(hover ? Color.accentColor : .clear, in: .rect(cornerRadius: 6))
        .contentShape(.rect)
    }
    .buttonStyle(.plain)
    .onHover { hover = $0 }
  }
}
