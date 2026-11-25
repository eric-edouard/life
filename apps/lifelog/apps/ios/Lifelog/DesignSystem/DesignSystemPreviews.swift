import LifeConnector
import SwiftUI

#if DEBUG
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
