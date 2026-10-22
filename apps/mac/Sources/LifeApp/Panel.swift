import AppKit
import SwiftUI

/// The menu-bar panel under Life's L: how Life stands at a glance (the parts in trouble, the night, the memory, the
/// tasks, the engine, the last 24 hours) and its few actions.
struct Panel: View {
  let supervisor: Supervisor
  let openSettings: () -> Void
  let openStatus: () -> Void
  @State private var code: String?

  /// The parts the panel shows at a glance, when the status snapshot has them.
  private static let glance = ["nightly", "memory", "tasks", "engine"]

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      if supervisor.info?.started == true {
        header
        if let snapshot = supervisor.snapshot {
          rows(snapshot.troubled + Self.glance.compactMap { id in
            snapshot.cards.first { $0.id == id && !snapshot.trouble.contains(id) }
          })
          VStack(alignment: .leading, spacing: 8) {
            Text("24 h").label()
            DayStrip(ticks: snapshot.today, now: snapshot.observedAt, height: 26)
          }
          .padding(16)
        } else {
          Text("Not answering").font(Brand.serif(14)).foregroundStyle(Brand.muted).padding(16)
        }
        actions
      } else {
        Text("Not set up").font(Brand.serif(16, .semibold)).padding(16)
      }
      menu
    }
    .frame(width: 360)
    .background(Brand.page)
    .foregroundStyle(Brand.ink)
    .onAppear { Task { await supervisor.refreshPlate() } }
  }

  private var header: some View {
    HStack(spacing: 10) {
      Wordmark(height: 22)
      Spacer()
      if let snapshot = supervisor.snapshot {
        let n = snapshot.troubled.count
        Pill(tone: n == 0 ? .ok : snapshot.troubleTone, word: n == 0 ? "ok" : "\(n) to look at")
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
              Text(card.name).font(Brand.serif(14, .semibold)).lineLimit(1)
              if card.headline != card.word {
                Text(card.headline).font(Brand.serif(12.5)).foregroundStyle(Brand.muted).lineLimit(1)
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
        .overlay(alignment: .top) { Rectangle().fill(i == 0 ? .clear : Brand.rule).frame(height: 1) }
      }
    }
    .background(Brand.page, in: .rect(cornerRadius: Brand.panel))
    .overlay { RoundedRectangle(cornerRadius: Brand.panel).strokeBorder(Brand.rule) }
    .padding(.horizontal, 12)
  }

  private var actions: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(spacing: 8) {
        Button(action: openStatus) {
          Text("Status").frame(maxWidth: .infinity).padding(.vertical, 9)
            .background(Brand.ink, in: .rect(cornerRadius: Brand.control)).foregroundStyle(Brand.page)
        }
        Button {
          Task { code = await Helper.run(["pair"]).out.trimmingCharacters(in: .whitespacesAndNewlines) }
        } label: {
          Text("Pair an app").frame(maxWidth: .infinity).padding(.vertical, 9)
            .background(Brand.surface, in: .rect(cornerRadius: Brand.control))
        }
      }
      .buttonStyle(.plain)
      .font(Brand.serif(13.5, .semibold))
      if let code {
        HStack {
          Text(code).font(Brand.mono(13, .medium)).textSelection(.enabled)
          Spacer()
          Text("5 min").font(Brand.mono(11)).foregroundStyle(Brand.muted)
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
    .overlay(alignment: .top) { Rectangle().fill(Brand.rule).frame(height: 1) }
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
      Text(title).font(Brand.serif(14))
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 10)
        .padding(.vertical, 5)
        .foregroundStyle(hover ? Brand.page : Brand.ink)
        .background(hover ? Brand.ink : .clear, in: .rect(cornerRadius: 8))
        .contentShape(.rect)
    }
    .buttonStyle(.plain)
    .onHover { hover = $0 }
  }
}
