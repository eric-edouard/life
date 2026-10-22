import AppKit
import SwiftUI

/// A card opened over the plate: its facts, his words when shown, the sentence for Claude, its history (a sweep's runs
/// open to their steps) and its raw log lines, each paging back through the whole log.
struct OpenCard: View {
  let card: Card
  let status: Status
  let showContent: Bool
  let close: () -> Void
  @State private var detail: Detail?
  @State private var history: [Detail.Entry] = []
  @State private var log: [String] = []
  @State private var next = Detail.Next(history: nil, log: nil)
  @State private var run: String?
  @State private var copied = false

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 22) {
        header
        facts
        if showContent, let lines = card.content, !lines.isEmpty {
          VStack(alignment: .leading, spacing: 6) {
            ForEach(lines, id: \.self) { Text($0).font(Ledger.serif(14)).textSelection(.enabled) }
          }
          .padding(12)
          .frame(maxWidth: .infinity, alignment: .leading)
          .background(Ledger.sunk, in: .rect(cornerRadius: 8))
        }
        if let ask = card.ask, showContent { askBox(ask) }
        section("History") { historyList }
        section("Log") { logList }
      }
      .padding(.horizontal, 34)
      .padding(.vertical, 30)
    }
    .scrollIndicators(.never)
    .frame(width: 720)
    .frame(maxHeight: 700)
    .background(Ledger.panel, in: .rect(cornerRadius: 16))
    .overlay { RoundedRectangle(cornerRadius: 16).strokeBorder(Ledger.line) }
    .shadow(color: .black.opacity(0.35), radius: 50, y: 30)
    .task(id: card.id) {
      guard let d = await status.detail(card.id) else { return }
      detail = d
      history = d.history
      log = d.log
      next = d.next
    }
  }

  private var header: some View {
    HStack(alignment: .top) {
      VStack(alignment: .leading, spacing: 6) {
        Text(card.group == "mac" ? "The Mac" : card.group.capitalized)
          .font(Ledger.mono(10.5, .medium)).textCase(.uppercase).kerning(0.8).foregroundStyle(Ledger.muted)
        Text(card.name).font(Ledger.serif(34, .semibold))
        Text(card.headline).font(Ledger.serif(15)).foregroundStyle(Ledger.muted)
      }
      Spacer()
      Pill(tone: card.tone, word: card.word)
      Button("Close", systemImage: "xmark", action: close)
        .labelStyle(.iconOnly)
        .buttonStyle(.plain)
        .frame(width: 28, height: 28)
        .background(Ledger.sunk, in: .circle)
        .keyboardShortcut(.cancelAction)
    }
  }

  private var facts: some View {
    LazyVGrid(columns: [GridItem(.adaptive(minimum: 140), spacing: 18, alignment: .topLeading)], spacing: 16) {
      ForEach(card.facts, id: \.self) { f in
        VStack(alignment: .leading, spacing: 3) {
          Text(f.value ?? f.at.map(ago) ?? "never").font(Ledger.mono(17, .medium)).lineLimit(2)
          Text(f.label).font(Ledger.serif(12)).foregroundStyle(Ledger.muted).lineLimit(2)
        }
        .padding(.top, 9)
        .overlay(alignment: .top) { Rectangle().fill(Ledger.line).frame(height: 2) }
      }
    }
  }

  private func askBox(_ ask: String) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      Text("For Claude").font(Ledger.mono(10.5, .medium)).textCase(.uppercase).foregroundStyle(Ledger.muted)
      Text(ask).font(Ledger.serif(14)).textSelection(.enabled)
      Button(copied ? "Copied" : "Copy") {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(ask, forType: .string)
        copied = true
      }
    }
    .padding(12)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(Ledger.sunk, in: .rect(cornerRadius: 8))
  }

  @ViewBuilder private var historyList: some View {
    if detail == nil {
      Text("Reading…").foregroundStyle(Ledger.muted)
    } else if history.isEmpty {
      Text("Nothing in 7 days").foregroundStyle(Ledger.muted)
    } else {
      VStack(alignment: .leading, spacing: 0) {
        ForEach(Array(history.enumerated()), id: \.offset) { _, e in
          entry(e)
        }
        if let before = next.history {
          Button("Older") { Task { await more(before, history: true) } }.padding(.top, 10)
        }
      }
    }
  }

  private func entry(_ e: Detail.Entry) -> some View {
    VStack(alignment: .leading, spacing: 4) {
      HStack(alignment: .firstTextBaseline, spacing: 12) {
        Circle().fill(e.tone.color).frame(width: 7, height: 7)
        if let id = e.run {
          Button(e.title) { withAnimation(.smooth) { run = run == id ? nil : id } }
            .buttonStyle(.plain).font(Ledger.serif(14, .semibold))
        } else {
          Text(e.title).font(Ledger.serif(14, .semibold))
        }
        Spacer()
        if let sub = e.sub { Text(sub).font(Ledger.mono(11)).foregroundStyle(Ledger.muted).lineLimit(1) }
        if let at = e.at { Text(ago(at)).font(Ledger.mono(11)).foregroundStyle(Ledger.muted) }
      }
      if showContent, let content = e.content {
        Text(content).font(Ledger.serif(12.5)).foregroundStyle(Ledger.muted).padding(.leading, 19).textSelection(.enabled)
      }
      if let id = e.run, run == id {
        RunSteps(id: id, status: status).padding(.leading, 19).transition(.opacity)
      }
    }
    .padding(.vertical, 10)
    .overlay(alignment: .top) { Rectangle().fill(Ledger.line).frame(height: 1) }
  }

  @ViewBuilder private var logList: some View {
    if !showContent {
      Text("Hidden").foregroundStyle(Ledger.muted)
    } else if log.isEmpty {
      Text("Nothing in 7 days").foregroundStyle(Ledger.muted)
    } else {
      VStack(alignment: .leading, spacing: 10) {
        Text(log.joined(separator: "\n"))
          .font(Ledger.mono(11))
          .textSelection(.enabled)
          .frame(maxWidth: .infinity, alignment: .leading)
          .padding(12)
          .background(Ledger.sunk, in: .rect(cornerRadius: 8))
        if let before = next.log {
          Button("Older") { Task { await more(before, history: false) } }
        }
      }
    }
  }

  private func section(_ title: String, @ViewBuilder _ content: () -> some View) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      Text(title).font(Ledger.mono(10.5, .medium)).textCase(.uppercase).kerning(0.8).foregroundStyle(Ledger.muted)
      content()
    }
  }

  /// The next page of one list, back through the whole log.
  private func more(_ before: String, history isHistory: Bool) async {
    guard let d = await status.detail(card.id, before: before) else { return }
    if isHistory {
      history += d.history
      next = Detail.Next(history: d.next.history, log: next.log)
    } else {
      log += d.log
      next = Detail.Next(history: next.history, log: d.next.log)
    }
  }
}
