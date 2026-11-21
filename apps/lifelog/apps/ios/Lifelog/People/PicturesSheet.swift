import LifeConnector
import SwiftUI

/// The picture a person or an organization shows, picked (`DuoFoldPersonPictures`): every picture Life kept for them,
/// one per source, each with its source's mark, then their initials ("No picture"); the one in use is checked. A tap
/// on another works on that disc until Life took it and their read shows it, then the sheet closes and the page says
/// "Picture changed" with Undo (`LifeStore.setPicture`); refused, Life's reason stands under the grid.
struct PicturesSheet: View {
    let now: PersonNow

    @Environment(LifeStore.self) private var life
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        let party = now.row.party
        let picking = life.picturePicking(party.ref)
        let inUse = picking ?? now.pictureInUse
        VStack(alignment: .leading, spacing: Metrics.Spacing.xl) {
            SheetHeader(title: "Picture") { dismiss() }
            // Four a row, from the left.
            let sources = now.pictures.map(\.source) + [PersonNow.noPicture]
            VStack(alignment: .leading, spacing: Metrics.Spacing.l) {
                ForEach(Array(stride(from: 0, to: sources.count, by: 4)), id: \.self) { start in
                    HStack(spacing: Metrics.Spacing.l) {
                        ForEach(sources[start..<min(start + 4, sources.count)], id: \.self) { source in
                            disc(party, source: source, inUse: inUse)
                        }
                    }
                }
            }
            .disabled(picking != nil).offWhileOutOfReach()
            footer
        }
        .padding(.horizontal, Metrics.gutter).padding(.top, Metrics.Spacing.s)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(Palette.sheet)
        .sheetStack()
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
        .motion(Motion.standard, value: picking)
    }

    /// Where they come from, or why his last pick was not taken.
    @ViewBuilder private var footer: some View {
        if case .failed(let failure, _) = life.state(of: .picture(now.row.party.ref)) {
            Label(failure.reason, systemImage: "exclamationmark.triangle").font(.small).foregroundStyle(Palette.fg)
        } else {
            Text(now.picturesFrom).font(.small).foregroundStyle(Palette.muted)
        }
    }

    /// One choice: that source's picture with its mark, or their initials for `none`.
    private func disc(_ party: Party, source: String, inUse: String) -> some View {
        let picture = now.pictures.first { $0.source == source }
        let isInUse = source == inUse
        let isWorking = life.picturePicking(party.ref) == source
        return Button {
            choose(source)
        } label: {
            PartyDisc(party.showing(picture?.id), size: .page, badge: picture?.source, ring: Palette.sheet)
                .overlay {
                    if isWorking { Spinner().foregroundStyle(Palette.fg).padding(Metrics.Spacing.m) }
                }
                .overlay(alignment: .topTrailing) {
                    if isInUse, !isWorking {
                        Image(systemName: "checkmark").font(.small).fontWeight(.bold).foregroundStyle(Palette.sheet)
                            .frame(width: 24, height: 24).background(Palette.ok, in: .circle)
                            .offset(x: 4, y: -4)
                    }
                }
                .contentShape(.circle)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(picture.map { "\(Self.sourceName($0.source)) picture" } ?? "No picture")
        .accessibilityAddTraits(isInUse ? .isSelected : [])
    }

    /// His pick sent, the one it replaces kept for Undo; the one in use tapped again only closes the sheet.
    private func choose(_ source: String) {
        let was = now.pictureInUse
        guard source != was else { return dismiss() }
        let party = now.row.party
        Task {
            await life.setPicture(of: party.ref, name: party.name, kind: party.kind, from: source, was: was)
            if case .succeeded = life.state(of: .picture(party.ref)) { dismiss() }
        }
    }

    static func sourceName(_ source: String) -> String {
        source == "contacts" ? "Contacts" : Channel.name(source)
    }
}

/// Their picture at the head of their page (56): when he can pick one (`PersonNow.pictures`), a tap opens the picture
/// sheet; else it is only their picture.
struct HeadPicture: View {
    let party: Party
    /// Their read, when it offers pictures to pick from.
    var now: PersonNow?

    @State private var isPicking = Self.opensAtLaunch
    @Environment(LifeStore.self) private var life

    var body: some View {
        if let now, !now.pictures.isEmpty {
            Button {
                isPicking = true
            } label: {
                PartyDisc(party, size: .head).contentShape(.circle)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Change picture").accessibilityHint("Picks which of their pictures shows")
            .sheet(isPresented: $isPicking) { PicturesSheet(now: now) }
            // Every choice on hand before the sheet opens.
            .task(id: now.pictures) {
                let (parties, pairing) = (life.parties, life.parties.generation.current)
                await parties.pictures.want(now.pictures.map(\.id)) { parties.generation.current == pairing }
            }
        } else {
            PartyDisc(party, size: .head)
        }
    }

    /// `-fixtureSheet pictures`: the sheet over the page on show, to be photographed.
    private static var opensAtLaunch: Bool {
        #if DEBUG
            LifeFixture.sheet == "pictures"
        #else
            false
        #endif
    }
}
