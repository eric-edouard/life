import AppKit
import ServiceManagement
import SwiftUI

/// The menu-bar app: runs Life (`Supervisor`), shows how it stands, and opens Settings, which is also the first run's
/// setup until the owner's data exists.
@main
struct LifeApp: App {
  @State private var supervisor = Supervisor()
  @Environment(\.openWindow) private var openWindow

  var body: some Scene {
    MenuBarExtra("Life", systemImage: "waveform") {
      Menu(supervisor: supervisor, openSettings: {
        NSApp.activate()
        openWindow(id: "settings")
      })
      .task {
        supervisor.start()
        if !Helper.started {
          NSApp.activate()
          openWindow(id: "settings")
        }
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
  @State private var code: String?

  var body: some View {
    if Helper.started {
      ForEach(Supervisor.services.map { $0.joined(separator: " ") }, id: \.self) { name in
        Text("\(name.capitalized): \(supervisor.running[name] == true ? "running" : "stopped")")
      }
      if let at = supervisor.lastTick {
        Text("Last check: \(at.formatted(date: .omitted, time: .shortened))")
      }
      Divider()
      Button("Connect an AI app…") {
        Task { code = await Helper.run(["pair"]).out.trimmingCharacters(in: .whitespacesAndNewlines) }
      }
      if let code {
        Text("Pairing code: \(code) (5 minutes)").textSelection(.enabled)
      }
      Button("Open the last report") { openLastReport() }
    } else {
      Text("Life is not set up yet")
    }
    Divider()
    Button("Settings…", action: openSettings)
    Button("Quit Life") {
      supervisor.stop()
      NSApp.terminate(nil)
    }
  }

  private func openLastReport() {
    let dir = Helper.state.appending(path: "reports")
    let newest = (try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: [.contentModificationDateKey]))?
      .max { a, b in
        let da = (try? a.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
        let db = (try? b.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
        return da < db
      }
    if let newest { NSWorkspace.shared.open(newest) }
  }
}

/// One source as the helper reports it (`life sources`).
struct Source: Decodable, Identifiable {
  let name: String
  let label: String
  let on: Bool
  let missing: String?
  var id: String { name }
}

/// Settings, and the first run's setup: every value goes through the helper (`life settings set`), secrets to the
/// Keychain.
struct SettingsView: View {
  let supervisor: Supervisor
  @State private var started = Helper.started
  @State private var name = ""
  @State private var email = ""
  @State private var settings: [String: Any] = [:]
  @State private var sources: [Source] = []
  @State private var engine = "claude"
  @State private var key = ""
  @State private var agentName = ""
  @State private var wake = ""
  @State private var transport = "mcp-event"
  @State private var lifelogURL = ""
  @State private var lifelogToken = ""
  @State private var origin = ""
  @State private var status = ""
  @State private var loginItem = SMAppService.mainApp.status == .enabled

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
          if sources.contains(where: { $0.on && $0.missing?.contains("Full Disk Access") == true }) {
            Button("Open Full Disk Access") {
              NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles")!)
            }
            Text("Turn Life on there, then come back: it checks again.").font(.caption)
          }
          TextField("lifelog address", text: $lifelogURL)
          SecureField("lifelog token", text: $lifelogToken)
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
      if started { Task { await loadSources() } }
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
          await loadSources()
        }
      })
  }

  private func load() async {
    guard started else { return }
    let out = await Helper.run(["settings"]).out
    settings = (try? JSONSerialization.jsonObject(with: Data(out.utf8))) as? [String: Any] ?? [:]
    engine = settings["engine"] as? String ?? "claude"
    let agent = settings["agent"] as? [String: Any]
    agentName = agent?["name"] as? String ?? ""
    wake = (agent?["wake"] as? [String])?.first ?? ""
    transport = agent?["transport"] as? String ?? "mcp-event"
    lifelogURL = (settings["lifelog"] as? [String: Any])?["url"] as? String ?? ""
    origin = (settings["connector"] as? [String: Any])?["origin"] as? String ?? ""
    lifelogToken = Keychain.read("LIFELOG_TOKEN") ?? ""
    key = Keychain.read(engine == "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY") ?? ""
    await loadSources()
  }

  private func loadSources() async {
    let out = await Helper.run(["sources"]).out
    sources = (try? JSONDecoder().decode([Source].self, from: Data(out.utf8))) ?? sources
  }

  private func start() async {
    let r = await Helper.run(["init", "--name", name] + (email.isEmpty ? [] : ["--email", email]))
    status = r.code == 0 ? "Life is set up." : r.out
    started = Helper.started
    if started {
      supervisor.start()
      await load()
    }
  }

  private func set(_ parts: [String: Any]) async {
    guard let json = try? JSONSerialization.data(withJSONObject: parts) else { return }
    let r = await Helper.run(["settings", "set", String(decoding: json, as: UTF8.self)])
    status = r.code == 0 ? "Saved." : r.out
  }

  private func save() async {
    if engine == "anthropic" || engine == "openai" {
      Keychain.write(engine == "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY", key)
    }
    Keychain.write("LIFELOG_TOKEN", lifelogToken)
    var parts: [String: Any] = ["engine": engine]
    if !agentName.isEmpty {
      let words = wake.isEmpty ? agentName.lowercased() : wake
      parts["agent"] = ["name": agentName, "wake": [words], "transport": transport]
        .merging(transport == "mcp-event" ? ["client": "openai-mcp"] : [:]) { a, _ in a }
    }
    if !lifelogURL.isEmpty { parts["lifelog"] = ["url": lifelogURL] }
    await set(parts)
    supervisor.restart()
  }

  private func connect(public publicToo: Bool) async {
    let r = await Helper.run(["connect"] + (publicToo ? ["--public"] : []))
    status = r.out.trimmingCharacters(in: .whitespacesAndNewlines)
    if r.code == 0 {
      await load()
      supervisor.restart()
    }
  }
}
