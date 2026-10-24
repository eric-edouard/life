import SwiftUI

#if DEBUG
    private struct Swatch: Identifiable {
        let name: String
        let color: Color
        var id: String { name }
    }

    private let swatches = [
        Swatch(name: "ground", color: Palette.ground), Swatch(name: "surface1", color: Palette.surface1),
        Swatch(name: "surface2", color: Palette.surface2), Swatch(name: "surface3", color: Palette.surface3),
        Swatch(name: "hairline", color: Palette.hairline), Swatch(name: "textPrimary", color: Palette.textPrimary),
        Swatch(name: "textBody", color: Palette.textBody), Swatch(name: "textSecondary", color: Palette.textSecondary),
        Swatch(name: "textTertiary", color: Palette.textTertiary), Swatch(name: "redFill", color: Palette.redFill),
        Swatch(name: "redText", color: Palette.redText), Swatch(name: "textOnRed", color: Palette.textOnRed),
        Swatch(name: "liveDot", color: Palette.liveDot),
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
                                RoundedRectangle(cornerRadius: Metrics.Radius.field).strokeBorder(Palette.hairline)
                            }
                        Text(swatch.name).font(.caption).foregroundStyle(Palette.textSecondary)
                    }
                }
            }
            .padding(Metrics.gutter)
        }
        .background(Palette.ground)
        .preferredColorScheme(.dark)
    }

    #Preview("Type") {
        VStack(alignment: .leading, spacing: 12) {
            Text("Lunch with Julien — French").font(.readerTitle)
            Text("Standup: Pendant sync bug").font(.rowTitle)
            Text("Conversation at 13:52").font(.placeholderTitle).foregroundStyle(Palette.textBody)
            Text("Pages drop when the phone sleeps; Pim retries reads with backoff by Friday.")
                .font(.subheadline).foregroundStyle(Palette.textSecondary)
            Text("14:18").font(.monoTime)
            Text("10 conversations").font(.monoDetail).foregroundStyle(Palette.textTertiary)
            Text("30:20  −27:52").font(.monoSmall).foregroundStyle(Palette.textSecondary)
        }
        .foregroundStyle(Palette.textPrimary)
        .padding(Metrics.gutter)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(Palette.ground)
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
                    .foregroundStyle(Palette.textSecondary)
                    HStack {
                        DurationText(.seconds(40))
                        DurationText(.seconds(7080), font: .monoTime)
                    }
                    .foregroundStyle(Palette.textTertiary)
                    VStack(alignment: .leading, spacing: 8) {
                        ProcessingBadge(title: "Recording", glyph: .recording)
                        ProcessingBadge(title: "Transcribing…", glyph: .working)
                        ProcessingBadge(title: "Not transcribed yet", glyph: .waiting)
                        ProcessingBadge(title: "Transcription failed", glyph: .failed)
                    }
                    PassageText(
                        text: "Je t’envoie le contact du proprio, il cherche quelqu’un pour février.",
                        color: Palette.textPrimary, lit: NSRange(location: 10, length: 2)
                    )
                    .padding(12)
                    .background(Palette.surface2, in: .rect(cornerRadius: Metrics.Radius.passage))
                }
                .foregroundStyle(Palette.textPrimary)
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
        .background(Palette.ground)
        .preferredColorScheme(.dark)
    }
#endif
