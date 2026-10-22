import AppKit
import ServiceManagement
import Sparkle
import SwiftUI

/// Sparkle, when the bundle carries the release key (`scripts/app.ts`, `LIFE_SPARKLE_KEY`): a build without one never
/// looks for updates.
@MainActor let updates: SPUStandardUpdaterController? = {
  let key = Bundle.main.object(forInfoDictionaryKey: "SUPublicEDKey") as? String ?? ""
  return key.isEmpty
    ? nil : SPUStandardUpdaterController(startingUpdater: true, updaterDelegate: nil, userDriverDelegate: nil)
}()

/// The menu-bar app: runs Life (`Supervisor`), shows how it stands, and opens Settings, which is also the first run's
/// setup until the owner's data exists.
/// Starts Life when the app launches (at login too), not when its menu is first opened: a menu-bar app's menu is built
/// only when clicked.
@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
  let supervisor = Supervisor()

  func applicationDidFinishLaunching(_ notification: Notification) {
    Task { await supervisor.start() }
  }
}

@main
struct LifeApp: App {
  @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
  @Environment(\.openWindow) private var openWindow
  private var supervisor: Supervisor { delegate.supervisor }
  /// Life's L for the menu bar (`life-l.pdf`, from assets/brand/life-l.svg by `scripts/app.ts`): a template image,
  /// so macOS paints it for a light or a dark bar.
  private static let mark: NSImage = {
    let image = NSImage(named: "life-l")!
    image.isTemplate = true
    return image
  }()

  var body: some Scene {
    MenuBarExtra {
      Panel(
        supervisor: supervisor,
        openSettings: {
          NSApp.activate()
          openWindow(id: "settings")
        },
        openStatus: {
          NSApp.activate()
          openWindow(id: "status")
        }
      )
      .task {
        await supervisor.start()
        if supervisor.info?.started == false {
          NSApp.activate()
          openWindow(id: "settings")
        }
      }
    } label: {
      Image(nsImage: Self.mark).accessibilityLabel("Life")
    }
    .menuBarExtraStyle(.window)
    Window("Life", id: "status") {
      if let status = supervisor.info?.status {
        StatusWindow(supervisor: supervisor, status: status)
      } else {
        Text("Not answering").font(Brand.serif(18)).foregroundStyle(Brand.muted).padding(40)
      }
    }
    .windowStyle(.hiddenTitleBar)
    Window("Life", id: "settings") {
      SettingsView(supervisor: supervisor)
        .frame(minWidth: 520, minHeight: 640)
    }
    .windowResizability(.contentSize)
  }
}

/// Settings, and the first run's setup: every value goes through the helper (`life settings set`), secrets to the
/// Keychain.
struct SettingsView: View {
  let supervisor: Supervisor
  @State private var name = ""
  @State private var email = ""
  @State private var engine = "claude"
  @State private var key = ""
  @State private var agentName = ""
  @State private var wake = ""
  @State private var transport = "mcp-event"
  /// The agent as saved, so a save keeps what this form doesn't show (`misheard`, `client`).
  @State private var agentSaved: [String: Any] = [:]
  /// remctl's download and installer, or an import, are under way: the controls they touch wait.
  @State private var installing = false
  @State private var lifelogURL = ""
  @State private var lifelogToken = ""
  @State private var origin = ""
  @State private var status = ""
  @State private var loginItem = SMAppService.mainApp.status == .enabled

  private var started: Bool { supervisor.info?.started == true }
  private var sources: [Source] { supervisor.info?.sources ?? [] }

  var body: some View {
    Form {
      if !started {
        Section("Who you are") {
          TextField("Your name", text: $name)
          TextField("Your email", text: $email)
          Button("Start Life") { Task { await start() } }
            .disabled(name.isEmpty || installing)
        }
        Section("Or bring your Life") {
          Button("Import an export…") { Task { await importExport() } }
            .disabled(installing)
          Text("A folder made by Export everything…, on this Mac or another: checked, then counted again.")
            .caption()
        }
      } else {
        Section("Thinking") {
          Picker("Engine", selection: $engine) {
            Text("Claude (your subscription)").tag("claude")
            Text("ChatGPT (your subscription, Codex)").tag("codex")
            Text("Anthropic API key").tag("anthropic")
            Text("OpenAI API key").tag("openai")
          }
          if engine == "anthropic" || engine == "openai" {
            SecureField("API key", text: $key)
          }
        }
        Section("Sources") {
          ForEach(sources) { s in
            Toggle(isOn: binding(for: s)) {
              VStack(alignment: .leading) {
                Text(s.label)
                if s.on, let why = s.missing {
                  Text(why).caption()
                }
              }
            }
          }
          if sources.contains(where: { $0.on && $0.fullDisk }) {
            Button("Open Full Disk Access") {
              NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles")!)
            }
            Text("Turn Life on there, then come back: it checks again.").caption()
          }
          TextField("lifelog address", text: $lifelogURL)
          SecureField("lifelog token", text: $lifelogToken)
        }
        if let r = supervisor.info?.reminders {
          Section("Reminders") {
            Toggle("Use your Reminders", isOn: Binding(
              get: { r.on },
              set: { on in Task { await setReminders(on, r) } }
            ))
            .disabled(installing)
            if r.on, !r.ready {
              // An update of Life moved the pin: remctl is behind (or gone) while Reminders is on.
              Button("Install remctl \(r.release.version)") { Task { await installRemctl(r) } }
                .disabled(installing)
            }
            Text(r.ready
              ? "Life adds reminders when you ask, keeps your agent's list and reads your changes back."
              : "Life uses remctl for Reminders: this installs remctl \(r.release.version) with its own installer.")
              .caption()
          }
        }
        Section("Your agent") {
          TextField("Its name (\"hey …\" wakes it)", text: $agentName)
          TextField("Wake word, as heard", text: $wake)
          Picker("It gets your asks", selection: $transport) {
            Text("Pushed to it (ChatGPT)").tag("mcp-event")
            Text("When it checks in (Claude)").tag("pull")
          }
        }
        Section("Reaching Life") {
          Text(origin.isEmpty ? "Not on your tailnet yet" : "\(origin)/mcp").textSelection(.enabled)
          HStack {
            Button("On my tailnet") { Task { await connect(public: false) } }
            Button("Public, for ChatGPT and Claude.ai") { Task { await connect(public: true) } }
          }
        }
        Section {
          Toggle("Open Life at login", isOn: $loginItem)
            .onChange(of: loginItem) { _, on in
              try? on ? SMAppService.mainApp.register() : SMAppService.mainApp.unregister()
            }
          Button("Save") { Task { await save() } }
          Button("Export everything…") { Task { await export() } }
        }
      }
      if !status.isEmpty {
        Text(status).caption()
      }
    }
    .formStyle(.grouped)
    .font(Brand.serif(13))
    .task { await load() }
    .onReceive(Timer.publish(every: 3, on: .main, in: .common).autoconnect()) { _ in
      // Full Disk Access is granted in System Settings: the sources' state is read again until it shows.
      if started { Task { await supervisor.refresh() } }
    }
  }

  private func binding(for s: Source) -> Binding<Bool> {
    Binding(
      get: { s.on },
      set: { on in
        Task {
          var names = sources.filter(\.on).map(\.name).filter { $0 != s.name }
          if on { names.append(s.name) }
          await set(["sources": names])
          // The helper reads its settings once: the archive and the watcher start again on the new sources.
          await supervisor.restart()
        }
      })
  }

  private func load() async {
    guard started else { return }
    let out = await Helper.run(["settings"]).out
    let settings = (try? JSONSerialization.jsonObject(with: Data(out.utf8))) as? [String: Any] ?? [:]
    engine = settings["engine"] as? String ?? "claude"
    let agent = settings["agent"] as? [String: Any]
    agentName = agent?["name"] as? String ?? ""
    agentSaved = agent ?? [:]
    wake = (agent?["wake"] as? [String])?.first ?? ""
    transport = agent?["transport"] as? String ?? "mcp-event"
    lifelogURL = (settings["lifelog"] as? [String: Any])?["url"] as? String ?? ""
    origin = (settings["connector"] as? [String: Any])?["origin"] as? String ?? ""
    lifelogToken = Keychain.read("LIFELOG_TOKEN") ?? ""
    key = Keychain.read(engine == "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY") ?? ""
  }

  private func start() async {
    let r = await Helper.run(["init", "--name", name] + (email.isEmpty ? [] : ["--email", email]))
    status = r.code == 0 ? "Life is set up." : r.err
    await supervisor.start()
    await load()
  }

  private func set(_ parts: [String: Any]) async {
    guard let json = try? JSONSerialization.data(withJSONObject: parts) else { return }
    let r = await Helper.run(["settings", "set", String(decoding: json, as: UTF8.self)])
    status = r.code == 0 ? "Saved." : r.err
  }

  private func save() async {
    if engine == "anthropic" || engine == "openai" {
      Keychain.write(engine == "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY", key)
    }
    Keychain.write("LIFELOG_TOKEN", lifelogToken)
    var parts: [String: Any] = ["engine": engine]
    if !agentName.isEmpty {
      let words = wake.isEmpty ? agentName.lowercased() : wake
      parts["agent"] = agentSaved.merging(["name": agentName, "wake": [words], "transport": transport]) { _, new in new }
    }
    if !lifelogURL.isEmpty { parts["lifelog"] = ["url": lifelogURL] }
    await set(parts)
    await supervisor.restart()
  }

  /// The Reminders plugin on or off. On needs remctl at the pinned release: its installer runs first (the Mac's password
  /// once, then its own permission steps), and the toggle takes once `life app` sees it.
  private func setReminders(_ on: Bool, _ r: Reminders) async {
    if on, !r.ready {
      await installRemctl(r)
      return
    }
    await set(["reminders": on])
    await supervisor.restart()
  }

  private func installRemctl(_ r: Reminders) async {
    installing = true
    status = await Remctl.install(r.release)
    installing = false
  }

  /// A Life export into this new install (`life import`): checked against its manifest, never over anything.
  private func importExport() async {
    let panel = NSOpenPanel()
    panel.canChooseDirectories = true
    panel.canChooseFiles = false
    guard panel.runModal() == .OK, let url = panel.url else { return }
    status = "Importing…"
    installing = true
    let r = await Helper.run(["import", url.path])
    installing = false
    status = (r.code == 0 ? r.out : r.err).trimmingCharacters(in: .whitespacesAndNewlines)
    if r.code == 0 {
      await supervisor.start()
      await load()
    }
  }

  /// Everything Life holds into a new folder, with its manifest (`life export`): no secrets, they are listed.
  private func export() async {
    let panel = NSSavePanel()
    panel.nameFieldStringValue = "Life export \(Date().formatted(.iso8601.year().month().day()))"
    guard panel.runModal() == .OK, let url = panel.url else { return }
    status = "Exporting…"
    let r = await Helper.run(["export", url.path])
    status = (r.code == 0 ? r.out : r.err).trimmingCharacters(in: .whitespacesAndNewlines)
  }

  private func connect(public publicToo: Bool) async {
    let r = await Helper.run(["connect"] + (publicToo ? ["--public"] : []))
    status = (r.code == 0 ? r.out : r.err).trimmingCharacters(in: .whitespacesAndNewlines)
    if r.code == 0 {
      await load()
      await supervisor.restart()
    }
  }
}
