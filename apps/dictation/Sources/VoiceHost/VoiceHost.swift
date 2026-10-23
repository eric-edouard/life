import AppKit
import QuietCore
import SwiftUI

/// Starts Life when the app launches (at login too), not when its menu is first opened: a menu-bar app builds its
/// menu only when clicked.
@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    let host = HostModel()

    func applicationDidFinishLaunching(_ notification: Notification) {
        if !host.setUp { NSApp.activate() }
        Task { await host.start() }
    }
}

/// Voice Host (packaging 4.6b): the menu-bar app that runs Life on this Mac (`HostModel`). Its Settings window
/// is also the first run's setup, and opens by itself until Life is set up.
@main
struct VoiceHost: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @Environment(\.openWindow) private var openWindow
    private var host: HostModel { delegate.host }

    /// The ring and dot of the iPhone app's icon (`menubar.pdf`, made by `scripts/host-app.ts`): a template image, so
    /// macOS paints it for a light or a dark bar.
    private static let mark: NSImage = {
        let image =
            NSImage(named: "menubar")
            ?? NSImage(systemSymbolName: "smallcircle.filled.circle", accessibilityDescription: nil) ?? NSImage()
        image.isTemplate = true
        return image
    }()

    var body: some Scene {
        MenuBarExtra {
            HostMenu(host: host) { id in
                NSApp.activate()
                openWindow(id: id)
            }
        } label: {
            Image(nsImage: Self.mark).accessibilityLabel("Voice Host")
        }
        Window("Voice Host", id: "settings") { SettingsView(host: host) }
            .windowResizability(.contentSize)
            .defaultLaunchBehavior(host.setUp ? .suppressed : .presented)
        Window("Voice Host status", id: "status") { StatusView(host: host) }
        Window("Pair an iPhone", id: "pair") { PairingCode(host: host).padding(24).frame(width: 340) }
            .windowResizability(.contentSize)
    }
}

/// The verdict, one line per part of the pipeline (and any other in trouble), then the windows.
struct HostMenu: View {
    let host: HostModel
    let open: (String) -> Void

    var body: some View {
        if host.setUp {
            let sections = Host.report(host.status, now: .now)
            Text(Host.verdict(sections))
            ForEach(sections.filter { $0.inMenu || $0.summary.trouble }) { section in
                let line = "\(section.summary.label): \(section.summary.value)"
                if section.summary.trouble {
                    Label(line, systemImage: "exclamationmark.triangle")
                } else {
                    Text(line)
                }
            }
        } else {
            Text("Voice Host: not set up yet")
        }
        ForEach(host.problems, id: \.self) { Label($0, systemImage: "exclamationmark.triangle") }
        Divider()
        if host.setUp {
            Button("Open status…") { open("status") }
            Button("Pair an iPhone…") { open("pair") }
                .disabled(host.pairingLink == nil)
        }
        Button("Settings…") { open("settings") }
        Divider()
        // Quitting stops every child: the model ends them on willTerminate.
        Button("Quit Life") { NSApp.terminate(nil) }
    }
}
