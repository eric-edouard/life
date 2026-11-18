import SwiftUI

#if DEBUG
    private struct Swatch: Identifiable {
        let name: String
        let color: Color
        var id: String { name }
    }

    private let swatches = [
        Swatch(name: "ground", color: Palette.bg), Swatch(name: "surface1", color: Palette.card),
        Swatch(name: "surface2", color: Palette.tile), Swatch(name: "surface3", color: Palette.paper),
        Swatch(name: "hairline", color: Palette.line), Swatch(name: "textPrimary", color: Palette.fg),
        Swatch(name: "textBody", color: Palette.fg), Swatch(name: "textSecondary", color: Palette.muted),
        Swatch(name: "textTertiary", color: Palette.faint), Swatch(name: "redFill", color: Palette.fg),
        Swatch(name: "redText", color: Palette.flag), Swatch(name: "textOnRed", color: Palette.on),
        Swatch(name: "liveDot", color: Palette.flag),
    ]

    #Preview("Palette") {
        ScrollView {
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 100))], spacing: 12) {
                ForEach(swatches) { swatch in
                    VStack(alignment: .leading, spacing: 6) {
                        RoundedRectangle(cornerRadius: Metrics.Radius.field)
                            .fill(swatch.color)
                            .frame(height: 56)
                            .overlay {
                                RoundedRectangle(cornerRadius: Metrics.Radius.field).strokeBorder(Palette.line)
                            }
                        Text(swatch.name).font(.caption).foregroundStyle(Palette.muted)
                    }
                }
            }
            .padding(Metrics.gutter)
        }
        .background(Palette.bg)
        .preferredColorScheme(.dark)
    }

    #Preview("Type") {
        VStack(alignment: .leading, spacing: 12) {
            Text("Lunch with Julien — French").font(.readerTitle)
            Text("Standup: Pendant sync bug").font(.rowTitle)
            Text("Conversation at 13:52").font(.placeholderTitle).foregroundStyle(Palette.fg)
            Text("Pages drop when the phone sleeps; Pim retries reads with backoff by Friday.")
                .font(.subheadline).foregroundStyle(Palette.muted)
            Text("14:18").font(.monoTime)
            Text("10 conversations").font(.monoDetail).foregroundStyle(Palette.faint)
            Text("30:20  −27:52").font(.monoSmall).foregroundStyle(Palette.muted)
        }
        .foregroundStyle(Palette.fg)
        .padding(Metrics.gutter)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(Palette.bg)
        .preferredColorScheme(.dark)
    }

    #Preview("Components") {
        @Previewable @State var playing = false
        ZStack(alignment: .bottom) {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    SectionHeader(title: "Today", detail: "Wed 7 Oct", trailing: "5 conversations")
                    HStack(spacing: Tag.between) {
                        Tag(systemImage: "person", value: Text("Julien, Nok"))
                        Tag(systemImage: "photo", value: Text("5").font(.monoDetail))
                    }
                    .font(.caption)
                    .foregroundStyle(Palette.muted)
                    HStack {
                        DurationText(.seconds(40))
                        DurationText(.seconds(7080), font: .monoTime)
                    }
                    .foregroundStyle(Palette.faint)
                    VStack(alignment: .leading, spacing: 8) {
                        ProcessingBadge(title: "Recording", glyph: .recording)
                        ProcessingBadge(title: "Transcribing…", glyph: .working)
                        ProcessingBadge(title: "Not transcribed yet", glyph: .waiting)
                        ProcessingBadge(title: "Transcription failed", glyph: .failed)
                    }
                }
                .foregroundStyle(Palette.fg)
                .padding(Metrics.gutter)
            }
            GlassEffectContainer(spacing: 12) {
                HStack(spacing: 12) {
                    Text("30:20").font(.monoSmall).padding(14)
                        .floatingGlass(in: .rect(cornerRadius: Metrics.Radius.player))
                    Button("Back 15 seconds", systemImage: "gobackward.15") {}
                        .labelStyle(.iconOnly)
                        .buttonStyle(.glass)
                        .buttonBorderShape(.circle)
                    Button(playing ? "Pause" : "Play", systemImage: playing ? "pause.fill" : "play.fill") {
                        playing.toggle()
                    }
                    .labelStyle(.iconOnly)
                    .primaryGlassButton()
                    .buttonBorderShape(.circle)
                    .controlSize(.large)
                }
            }
            .padding(.bottom, 24)
        }
        .background(Palette.bg)
        .preferredColorScheme(.dark)
    }
#endif
