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
@main
struct LifeApp: App {
  @State private var supervisor = Supervisor()
  @Environment(\.openWindow) private var openWindow

  var body: some Scene {
    MenuBarExtra("Life", systemImage: "waveform") {
      Menu(
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
    }
    Window("Life status", id: "status") {
      if let status = supervisor.info?.status {
        StatusPage(status: status).frame(minWidth: 900, minHeight: 700)
      } else {
        Text("Life isn't answering yet.").padding()
      }
    }
    Window("Life", id: "settings") {
      SettingsView(supervisor: supervisor)
        .frame(minWidth: 520, minHeight: 640)
    }
    .windowResizability(.contentSize)
  }
}

struct Menu: View {
  let supervisor: Supervisor
  let openSettings: () -> Void
  let openStatus: () -> Void
  @State private var code: String?

  var body: some View {
    if supervisor.info?.started == true {
      // The status page's own truth: its worst tone, every card in trouble, the page itself one click away.
      if let plate = supervisor.plate {
        Text(plate.troubled.isEmpty ? "Life: all good" : "Life: \(plate.troubled.count) to look at")
        ForEach(plate.troubled) { card in
          Text("\(card.name): \(card.word)")
        }
      } else {
        Text("Life: not answering")
      }
      Button("Open status…", action: openStatus)
      Divider()
      Button("Connect an AI app…") {
        Task { code = await Helper.run(["pair"]).out.trimmingCharacters(in: .whitespacesAndNewlines) }
      }
      if let code {
        Text("Pairing code: \(code) (5 minutes)").textSelection(.enabled)
      }
      if let report = supervisor.info?.lastReport {
        Button("Open the last report") { NSWorkspace.shared.open(URL(fileURLWithPath: report)) }
      }
    } else {
      Text("Life is not set up yet")
    }
    Divider()
    if let updates {
      Button("Check for Updates…") { updates.checkForUpdates(nil) }
    }
    Button("Settings…", action: openSettings)
    Button("Quit Life") {
      supervisor.stop()
      NSApp.terminate(nil)
    }
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
  /// remctl's download and installer are under way: the Reminders controls wait.
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
            .disabled(name.isEmpty)
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
                  Text(why).font(.caption).foregroundStyle(.secondary)
                }
              }
            }
          }
          if sources.contains(where: { $0.on && $0.fullDisk }) {
            Button("Open Full Disk Access") {
              NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles")!)
            }
            Text("Turn Life on there, then come back: it checks again.").font(.caption)
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
              .font(.caption).foregroundStyle(.secondary)
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
        }
      }
      if !status.isEmpty {
        Text(status).font(.caption).foregroundStyle(.secondary)
      }
    }
    .formStyle(.grouped)
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

  private func connect(public publicToo: Bool) async {
    let r = await Helper.run(["connect"] + (publicToo ? ["--public"] : []))
    status = (r.code == 0 ? r.out : r.err).trimmingCharacters(in: .whitespacesAndNewlines)
    if r.code == 0 {
      await load()
      await supervisor.restart()
    }
  }
}
