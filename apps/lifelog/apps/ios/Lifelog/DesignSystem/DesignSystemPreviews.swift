import LifeConnector
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
                        RoundedRectangle(cornerRadius: Metrics.Radius.tile)
                            .fill(swatch.color)
                            .frame(height: 56)
                            .overlay {
                                RoundedRectangle(cornerRadius: Metrics.Radius.tile).strokeBorder(Palette.line)
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
            Text("Lunch with Julien — French").font(.screenName)
            Text("Standup: Pendant sync bug").font(.rowName)
            Text("Conversation at 13:52").font(.cardHeadline).foregroundStyle(Palette.fg)
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

    #Preview("Rows: a server's value, five states") {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                RowGroup(label: "Asking, known, saving, saved, not changed", surface: .sheet) {
                    Row(title: "Transcription", state: .asking) {
                        RowSwitch(title: "Transcription", isOn: true) { _ in }
                    }
                    Row(title: "Transcription") { RowSwitch(title: "Transcription", isOn: true) { _ in } }
                    Row(title: "Transcription", state: .saving) {
                        RowSwitch(title: "Transcription", isOn: false) { _ in }
                    }
                    Row(title: "Transcription", state: .saved) {
                        RowSwitch(title: "Transcription", isOn: false) { _ in }
                    }
                    Row(title: "Transcription", state: .refused("Not changed: the server did not answer")) {
                        RowSwitch(title: "Transcription", isOn: true) { _ in }
                    }
                }
                RowGroup(label: "A value and a menu", surface: .sheet) {
                    Row(title: "Low battery") {
                        RowMenu(title: "Low battery", choices: [(0, "Off"), (20, "Below 20%")], selection: 20) { _ in }
                    }
                }
            }
            .padding(Metrics.gutter)
        }
        .background(Palette.sheet)
        .preferredColorScheme(.dark)
    }

    #Preview("Rows: a permission, three states") {
        ScrollView {
            RowGroup(label: "Allowed, not asked, refused", surface: .sheet) {
                Row(title: "Location", detail: "Where things were said") { StateMark(glyph: .ok, word: "On") }
                Row(title: "Location", detail: "Where things were said") { RowButton(title: "Allow") {} }
                Row(title: "Location", detail: "Change it in iOS Settings") {
                    StateMark(glyph: .flag, word: "Off")
                    RowButton(title: "Open") {}
                }
            }
            .padding(Metrics.gutter)
        }
        .background(Palette.sheet)
        .preferredColorScheme(.dark)
    }
#endif
