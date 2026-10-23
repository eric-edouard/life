import Export
import Library
import SwiftUI
import Timeline

/// Exports the given conversations. Presented from the library's multi-select. The primary action stays pinned in a
/// glass bar at the bottom; Cancel stops a running export and closes the sheet.
struct ExportSheet: View {
    let conversations: [UUID]

    @Environment(SyncStore.self) private var sync: SyncStore?
    @Environment(\.library) private var library
    @Environment(\.dismiss) private var dismiss
    @State private var store = ExportStore()

    var body: some View {
        NavigationStack {
            Form {
                Group {
                    Section {
                        Text(conversations.count == 1 ? "1 conversation" : "\(conversations.count) conversations")
                        Picker("Export", selection: $store.content) {
                            ForEach(ExportStore.Content.allCases, id: \.self) { Text($0.rawValue) }
                        }
                    }
                    if store.content != .text {
                        Section("Audio") {
                            ForEach(AudioFormat.allCases, id: \.self) { format in
                                Toggle(format.label, isOn: member(format, of: $store.audio))
                            }
                        }
                    }
                    if store.content != .audio {
                        Section {
                            ForEach(ExportFormat.allCases, id: \.self) { format in
                                Toggle(format.label, isOn: member(format, of: $store.text))
                            }
                        } header: {
                            Text("Text")
                        } footer: {
                            Text("PDF is not supported in this version.")
                        }
                    }
                }
                .disabled(isRunning)
                outcome
            }
            .navigationTitle("Export")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel", systemImage: "xmark") {
                        store.cancel()
                        dismiss()
                    }
                    .accessibilityIdentifier("export.cancel")
                }
            }
            .safeAreaInset(edge: .bottom) { actionBar }
        }
        // VoiceOver stays in the sheet: the library rows behind it are not reachable.
        .accessibilityAddTraits(.isModal)
    }

    /// What the last export left to read: what was not included, or why it failed.
    @ViewBuilder private var outcome: some View {
        switch store.state {
        case .finished(let result) where !result.manifest.unsupported.isEmpty:
            Section("Not included") {
                ForEach(Array(result.manifest.unsupported.enumerated()), id: \.offset) { _, item in
                    Text("\(item.what) \(item.item ?? ""). \(item.reason)")
                }
            }
        case .failed(let message):
            Section { Text("Export failed: \(message)") }
        default:
            EmptyView()
        }
    }

    /// The one primary action for the current state, always in view.
    private var actionBar: some View {
        VStack(spacing: 10) {
            switch store.state {
            case .idle:
                Button {
                    store.export(conversations, from: library, sync: sync)
                } label: {
                    Text("Export").frame(maxWidth: .infinity)
                }
                .primaryGlassButton()
                .disabled(!store.canExport || conversations.isEmpty)
                .accessibilityIdentifier("export.start")
            case .running(let fraction):
                ProgressView("Exporting", value: fraction)
                Button("Stop exporting", role: .cancel) { store.cancel() }
                    .buttonStyle(.glass)
                    .accessibilityIdentifier("export.stop")
            case .finished(let result):
                ShareLink(item: result.share) {
                    Text("Share export").frame(maxWidth: .infinity)
                }
                .primaryGlassButton()
                .accessibilityIdentifier("export.share")
                Button("Export again") { store.reset() }
                    .buttonStyle(.glass)
                    .accessibilityIdentifier("export.again")
            case .failed:
                Button {
                    store.reset()
                } label: {
                    Text("Try again").frame(maxWidth: .infinity)
                }
                .primaryGlassButton()
                .accessibilityIdentifier("export.retry")
            }
        }
        .controlSize(.large)
        .padding(16)
        .floatingGlass(in: .rect(cornerRadius: Metrics.Radius.player))
        .padding(.horizontal, 12)
        .padding(.bottom, 4)
    }

    private var isRunning: Bool {
        if case .running = store.state { true } else { false }
    }
}

/// A toggle for one member of a set of choices.
private func member<Value: Hashable>(_ value: Value, of set: Binding<Set<Value>>) -> Binding<Bool> {
    Binding {
        set.wrappedValue.contains(value)
    } set: { isOn in
        if isOn { set.wrappedValue.insert(value) } else { set.wrappedValue.remove(value) }
    }
}

extension AudioFormat {
    fileprivate var label: String {
        switch self {
        case .m4a: "M4A (compressed)"
        case .wav: "WAV (uncompressed)"
        }
    }
}

extension ExportFormat {
    fileprivate var label: String {
        switch self {
        case .txt: "Plain text"
        case .markdown: "Markdown"
        case .srt: "SRT captions"
        case .vtt: "WebVTT captions"
        case .json: "JSON data"
        }
    }
}

#if DEBUG
    #Preview {
        ExportSheet(conversations: [UUID()])
            .previewSync()
    }
#endif
