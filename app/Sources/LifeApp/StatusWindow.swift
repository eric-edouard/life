import SwiftUI

/// Life's status: one surface, the parts flowing left to right as data does (sources to outputs), the Mac along the
/// bottom, the last 24 hours above. A card opens in place over the plate. The plate is read every 3 s while open.
struct StatusWindow: View {
  let status: Status
  @State private var plate: Plate?
  @State private var opened: Card?
  @State private var unfolded: Set<String> = []
  @AppStorage("showContent") private var showContent = true
  @Namespace private var space

  /// A column shows its first cards, those in trouble always; the quiet rest fold away.
  private static let shown = 5

  var body: some View {
    ZStack {
      RadialGradient(colors: [Ledger.glow, Ledger.page], center: .init(x: 0.15, y: -0.1), startRadius: 0, endRadius: 900)
        .ignoresSafeArea()
      if let plate {
        overview(plate)
          .blur(radius: opened == nil ? 0 : 8)
          .opacity(opened == nil ? 1 : 0.35)
          .allowsHitTesting(opened == nil)
        if let card = opened {
          OpenCard(card: plate.cards.first { $0.id == card.id } ?? card, status: status, showContent: showContent) {
            close()
          }
          .matchedGeometryEffect(id: card.id, in: space)
          .transition(.scale(scale: 0.96).combined(with: .opacity))
          .zIndex(1)
        }
      } else {
        Text("Not answering").font(Ledger.serif(18)).foregroundStyle(Ledger.muted)
      }
    }
    .foregroundStyle(Ledger.ink)
    .frame(minWidth: 1100, minHeight: 760)
    .animation(.smooth, value: plate)
    .onExitCommand(perform: close)
    .task {
      while !Task.isCancelled {
        if let next = await status.plate() { plate = next }
        try? await Task.sleep(for: .seconds(3))
      }
    }
  }

  private func close() {
    withAnimation(.spring(duration: 0.4)) { opened = nil }
  }

  private func overview(_ plate: Plate) -> some View {
    VStack(alignment: .leading, spacing: 0) {
      HStack(spacing: 14) {
        Spacer()
        if !plate.troubled.isEmpty {
          Pill(tone: plate.worst == .bad ? .bad : .warn, word: "\(plate.troubled.count) to look at")
        }
        Toggle("Show content", isOn: $showContent).toggleStyle(.checkbox).font(Ledger.serif(12.5))
          .foregroundStyle(Ledger.muted)
        Pill(tone: .ok, word: plate.observedAt.formatted(date: .omitted, time: .standard))
      }
      .padding(.top, 12)
      .padding(.trailing, 20)

      VStack(alignment: .leading, spacing: 10) {
        Text(plate.observedAt, format: .dateTime.weekday(.wide).day().month(.wide))
          .font(Ledger.mono(10.5, .medium)).textCase(.uppercase).kerning(0.8).foregroundStyle(Ledger.muted)
        Text("Life").font(Ledger.serif(46, .semibold)).kerning(-0.6)
      }
      .padding(.horizontal, 44)
      .padding(.top, 18)

      DayStrip(ticks: plate.today, now: plate.observedAt, height: 44)
        .padding(.horizontal, 44)
        .padding(.top, 24)

      ScrollView {
        HStack(alignment: .top, spacing: 22) {
          ForEach(plate.groups.filter { $0.id != "mac" }) { g in
            column(g, plate.cards(in: g.id))
          }
        }
        .padding(.horizontal, 44)
        .padding(.vertical, 24)
      }
      .scrollIndicators(.never)

      mac(plate.cards(in: "mac"))
    }
  }

  private func column(_ group: Plate.Group, _ cards: [Card]) -> some View {
    let open = unfolded.contains(group.id)
    let quiet = { (c: Card) in c.tone == .ok || c.tone == .idle }
    let visible = open ? cards : cards.enumerated().filter { $0.offset < Self.shown || !quiet($0.element) }.map(\.element)
    return VStack(alignment: .leading, spacing: 8) {
      HStack {
        Text(group.name).font(Ledger.mono(10.5, .medium)).textCase(.uppercase).kerning(0.8)
        Spacer()
        Text(cards.count, format: .number).font(Ledger.mono(10.5))
      }
      .foregroundStyle(Ledger.muted)
      .padding(.bottom, 4)
      ForEach(visible) { card in
        Button {
          withAnimation(.spring(duration: 0.45)) { opened = card }
        } label: {
          CardTile(card: card)
            .matchedGeometryEffect(id: card.id, in: space, isSource: opened?.id != card.id)
        }
        .buttonStyle(.plain)
      }
      if cards.count > visible.count || open && cards.count > Self.shown {
        Button(open ? "Fewer" : "+\(cards.count - visible.count)") {
          withAnimation(.smooth) {
            if open { unfolded.remove(group.id) } else { unfolded.insert(group.id) }
          }
        }
        .buttonStyle(.plain)
        .font(Ledger.mono(11))
        .foregroundStyle(Ledger.muted)
      }
    }
    .frame(maxWidth: .infinity, alignment: .top)
  }

  private func mac(_ cards: [Card]) -> some View {
    HStack(spacing: 22) {
      Text("The Mac").font(Ledger.mono(10.5, .medium)).textCase(.uppercase).kerning(0.8)
      ForEach(cards) { card in
        Button {
          withAnimation(.spring(duration: 0.45)) { opened = card }
        } label: {
          HStack(spacing: 6) {
            Circle().fill(card.tone.color).frame(width: 7, height: 7)
            Text(card.name).foregroundStyle(Ledger.ink)
            Text(card.word).foregroundStyle(Ledger.muted)
          }
          .font(Ledger.serif(12.5))
        }
        .buttonStyle(.plain)
      }
      Spacer()
    }
    .padding(.top, 14)
    .overlay(alignment: .top) { Rectangle().fill(Ledger.line).frame(height: 1) }
    .padding(.horizontal, 44)
    .padding(.bottom, 22)
  }
}
