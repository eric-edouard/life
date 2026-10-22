import SwiftUI

/// Life's status: one surface, the parts flowing left to right as data does (sources to outputs), the Mac along the
/// bottom, the last 24 hours above. A card opens in place over the plate. The plate is read every 3 s while open.
struct StatusWindow: View {
  let supervisor: Supervisor
  let status: Status
  @State private var opened: Card?
  @State private var unfolded: Set<String> = []
  @AppStorage("showContent") private var showContent = true
  @Namespace private var space

  /// A column shows its first cards, those in trouble always; the quiet rest fold away.
  private static let shown = 5

  var body: some View {
    ZStack {
      Brand.page.ignoresSafeArea()
      if let plate = supervisor.plate {
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
        Text("Not answering").font(Brand.serif(18)).foregroundStyle(Brand.muted)
      }
    }
    .foregroundStyle(Brand.ink)
    .frame(minWidth: 1100, minHeight: 760)
    .animation(.smooth, value: supervisor.plate)
    .onExitCommand(perform: close)
    .task {
      while !Task.isCancelled {
        await supervisor.refreshPlate()
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
          Pill(tone: plate.troubleTone, word: "\(plate.troubled.count) to look at")
        }
        Toggle("Show content", isOn: $showContent).toggleStyle(.checkbox).font(Brand.serif(12.5))
          .foregroundStyle(Brand.muted)
        Pill(tone: .ok, word: plate.observedAt.formatted(date: .omitted, time: .standard))
      }
      .padding(.top, 12)
      .padding(.trailing, 20)

      VStack(alignment: .leading, spacing: 10) {
        Text(plate.observedAt, format: .dateTime.weekday(.wide).day().month(.wide))
          .label()
        Wordmark(height: 45)
      }
      .padding(.horizontal, 44)
      .padding(.top, 18)

      DayStrip(ticks: plate.today, now: plate.observedAt, height: 44)
        .padding(.horizontal, 44)
        .padding(.top, 24)

      ScrollView {
        HStack(alignment: .top, spacing: 22) {
          ForEach(plate.groups.filter { $0.id != "mac" }) { g in
            column(g, plate.cards(in: g.id), trouble: plate.trouble)
          }
        }
        .padding(.horizontal, 44)
        .padding(.vertical, 24)
      }
      .scrollIndicators(.never)

      mac(plate.cards(in: "mac"))
    }
  }

  private func column(_ group: Plate.Group, _ cards: [Card], trouble: [String]) -> some View {
    let open = unfolded.contains(group.id)
    let visible = open ? cards : cards.enumerated().filter { $0.offset < Self.shown || trouble.contains($0.element.id) }
      .map(\.element)
    return VStack(alignment: .leading, spacing: 8) {
      HStack {
        Text(group.name).label()
        Spacer()
        Text(cards.count, format: .number).font(Brand.mono(10.5)).foregroundStyle(Brand.muted)
      }
      .padding(.bottom, 4)
      ForEach(visible) { card in
        Button {
          withAnimation(.spring(duration: 0.45)) { opened = card }
        } label: {
          CardTile(card: card, trouble: trouble.contains(card.id))
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
        .font(Brand.mono(11))
        .foregroundStyle(Brand.muted)
      }
    }
    .frame(maxWidth: .infinity, alignment: .top)
  }

  private func mac(_ cards: [Card]) -> some View {
    HStack(spacing: 22) {
      Text("The Mac").label()
      ForEach(cards) { card in
        Button {
          withAnimation(.spring(duration: 0.45)) { opened = card }
        } label: {
          HStack(spacing: 6) {
            Circle().fill(card.tone.color).frame(width: 7, height: 7)
            Text(card.name).foregroundStyle(Brand.ink)
            Text(card.word).foregroundStyle(Brand.muted)
          }
          .font(Brand.serif(12.5))
        }
        .buttonStyle(.plain)
      }
      Spacer()
    }
    .padding(.top, 14)
    .overlay(alignment: .top) { Rectangle().fill(Brand.rule).frame(height: 1) }
    .padding(.horizontal, 44)
    .padding(.bottom, 22)
  }
}
