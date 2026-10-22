import AppKit
import SwiftUI

/// A card opened over the status snapshot: its facts, his words when shown, the sentence for Claude, its history (a sweep's runs
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
            ForEach(lines, id: \.self) { Text($0).font(Brand.serif(14)).textSelection(.enabled) }
          }
          .padding(12)
          .frame(maxWidth: .infinity, alignment: .leading)
          .background(Brand.surface, in: .rect(cornerRadius: Brand.control))
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
    .background(Brand.page, in: .rect(cornerRadius: Brand.panel))
    .overlay { RoundedRectangle(cornerRadius: Brand.panel).strokeBorder(Brand.rule) }
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
        Text(card.group == "mac" ? "The Mac" : card.group.capitalized).label()
        Text(card.name).font(Brand.serif(36, .semibold))
        Text(card.headline).font(Brand.serif(15)).foregroundStyle(Brand.muted)
      }
      Spacer()
      Pill(tone: card.tone, word: card.word)
      Button("Close", systemImage: "xmark", action: close)
        .labelStyle(.iconOnly)
        .buttonStyle(.plain)
        .frame(width: 28, height: 28)
        .background(Brand.surface, in: .circle)
        .keyboardShortcut(.cancelAction)
    }
  }

  private var facts: some View {
    LazyVGrid(columns: [GridItem(.adaptive(minimum: 140), spacing: 18, alignment: .topLeading)], spacing: 16) {
      ForEach(card.facts, id: \.self) { f in
        VStack(alignment: .leading, spacing: 3) {
          Text(f.value ?? f.at.map(ago) ?? "never").font(Brand.mono(17, .medium)).lineLimit(2)
          Text(f.label).font(Brand.serif(12)).foregroundStyle(Brand.muted).lineLimit(2)
        }
        .padding(.top, 9)
        .overlay(alignment: .top) { Rectangle().fill(Brand.rule).frame(height: 1) }
      }
    }
  }

  private func askBox(_ ask: String) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      Text("For Claude").label()
      Text(ask).font(Brand.serif(14)).textSelection(.enabled)
      Button(copied ? "Copied" : "Copy") {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(ask, forType: .string)
        copied = true
      }
    }
    .padding(12)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(Brand.surface, in: .rect(cornerRadius: Brand.control))
  }

  @ViewBuilder private var historyList: some View {
    if detail == nil {
      Text("Reading…").foregroundStyle(Brand.muted)
    } else if history.isEmpty {
      Text("Nothing in 7 days").foregroundStyle(Brand.muted)
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
            .buttonStyle(.plain).font(Brand.serif(14, .semibold))
        } else {
          Text(e.title).font(Brand.serif(14, .semibold))
        }
        Spacer()
        if let sub = e.sub { Text(sub).font(Brand.mono(11)).foregroundStyle(Brand.muted).lineLimit(1) }
        if let at = e.at { Text(ago(at)).font(Brand.mono(11)).foregroundStyle(Brand.muted) }
      }
      if showContent, let content = e.content {
        Text(content).font(Brand.serif(12.5)).foregroundStyle(Brand.muted).padding(.leading, 19).textSelection(.enabled)
      }
      if let id = e.run, run == id {
        RunSteps(id: id, status: status).padding(.leading, 19).transition(.opacity)
      }
    }
    .padding(.vertical, 10)
    .overlay(alignment: .top) { Rectangle().fill(Brand.rule).frame(height: 1) }
  }

  @ViewBuilder private var logList: some View {
    if !showContent {
      Text("Hidden").foregroundStyle(Brand.muted)
    } else if log.isEmpty {
      Text("Nothing in 7 days").foregroundStyle(Brand.muted)
    } else {
      VStack(alignment: .leading, spacing: 10) {
        Text(log.joined(separator: "\n"))
          .font(Brand.mono(11))
          .textSelection(.enabled)
          .frame(maxWidth: .infinity, alignment: .leading)
          .padding(12)
          .background(Brand.surface, in: .rect(cornerRadius: Brand.control))
        if let before = next.log {
          Button("Older") { Task { await more(before, history: false) } }
        }
      }
    }
  }

  private func section(_ title: String, @ViewBuilder _ content: () -> some View) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      Text(title).label()
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
