import AppKit
import QuietCore
import SwiftUI

/// The status window: every part of the pipeline in full (the menu's lines, opened up), the last day's problems, the
/// archive's invariants, and Host's own processes with their logs.
struct StatusView: View {
    let host: HostModel

    var body: some View {
        TimelineView(.periodic(from: .now, by: 30)) { context in
            Form {
                Section {
                    LabeledContent(
                        Host.verdict(Host.report(host.fullStatus, now: context.date)),
                        value: "checked \(Host.ago(host.fullStatusAt, now: context.date))")
                    Button("Check now") { Task { await host.refreshFullStatus() } }
                }
                ForEach(Host.report(host.fullStatus, now: context.date)) { section in
                    Section {
                        ForEach(Array(section.details.enumerated()), id: \.offset) { _, row in
                            RowView(row: row)
                        }
                    } header: {
                        HStack {
                            Text(section.summary.label)
                            Spacer()
                            Text(section.summary.value)
                                .foregroundStyle(section.summary.trouble ? .red : .secondary)
                        }
                    }
                }
                Section("On this Mac") {
                    ForEach(children, id: \.self) { child in
                        LabeledContent(child.title) {
                            HStack {
                                let restarts = host.supervisor.restarts[child, default: 0]
                                Text(
                                    (host.supervisor.running[child] == true ? "running" : "stopped")
                                        + (restarts > 0 ? ", restarted \(restarts)×" : ""))
                                Button("Log") { NSWorkspace.shared.open(child.log) }
                            }
                        }
                    }
                    if host.settings.backups {
                        LabeledContent("Backup repository", value: HostModel.backupRepository.path)
                            .textSelection(.enabled)
                    }
                    Button("Open the logs folder") {
                        NSWorkspace.shared.open(HostModel.home.appending(path: "Library/Logs"))
                    }
                }
            }
            .formStyle(.grouped)
        }
        .frame(minWidth: 520, minHeight: 640)
        .task { await host.refreshFullStatus() }
    }

    /// The tunnel only for "My own domain", speaker recognition only when it is on.
    private var children: [Child] {
        Child.allCases.filter {
            ($0 != .tunnel || host.settings.reach == .domain) && ($0 != .identity || host.settings.speakers)
        }
    }
}

private struct RowView: View {
    let row: QuietCore.Host.Row

    var body: some View {
        LabeledContent(row.label) {
            Text(row.value).foregroundStyle(row.trouble ? .red : .secondary).textSelection(.enabled)
        }
    }
}
