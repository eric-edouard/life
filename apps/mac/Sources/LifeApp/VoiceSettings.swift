import AppKit
import SwiftUI

/// Voice in Settings: whether it runs, its keys, speaker recognition, backups, the summaries' sign-ins and its
/// recordings' export and import. Every write goes through the helper (`life voice …`, `life settings set`), which
/// starts voice's launchd jobs again on it; the app never reads or writes voice's secrets itself.
struct VoiceSettings: View {
  @State private var voice: VoiceStatus?
  @State private var speakers = true
  @State private var backups = false
  @State private var elevenLabs = ""
  @State private var claudeToken = ""
  /// `codex login`, while a sign-in to ChatGPT waits in the browser.
  @State private var login: Process?
  @State private var busy = false
  @State private var note = ""

  var body: some View {
    Section("Voice") {
      HStack {
        Text(voice?.line ?? "Checking…")
        Spacer()
        Pill(tone: voice?.answering == true ? .ok : .idle, word: voice?.answering == true ? "running" : "off")
      }
      if let logs = voice?.logs {
        HStack {
          Text("Logs").caption()
          ForEach(logs.keys.sorted(), id: \.self) { child in
            Button(child) { NSWorkspace.shared.open(URL(fileURLWithPath: logs[child] ?? "")) }
              .buttonStyle(.link)
          }
        }
      }
      SecureField(
        voice?.elevenLabsKey == true ? "ElevenLabs API key (saved; type to replace)" : "ElevenLabs API key",
        text: $elevenLabs)
      Link(
        "Get one at elevenlabs.io: Developers, then API keys",
        destination: URL(string: "https://elevenlabs.io/app/developers/api-keys")!
      ).font(Brand.serif(11))
      Button(voice?.recorded == false ? "Start fresh" : "Save the key") {
        Task {
          await act(["voice", "key", "elevenLabsKey"], input: elevenLabs, done: "Saved.")
          elevenLabs = ""
        }
      }
      .disabled(elevenLabs.isEmpty || busy)
      Toggle("Recognize speakers by their voice", isOn: saving($speakers))
        .disabled(voice?.speakers == nil)
      Text("Names the voices you've named before, on this Mac; installs about 630 MB once. Off, voices stay unnamed.")
        .caption()
      Toggle("Back up to iCloud Drive every day", isOn: saving($backups))
        .disabled(voice?.iCloud != true || voice?.backups == nil)
      if voice?.iCloud == false {
        Text("Turn on iCloud Drive in System Settings first.").caption()
      } else if backups {
        Button("Copy the backup password") {
          Task {
            let r = await Helper.run(["voice", "backup-password"])
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(r.out.trimmingCharacters(in: .whitespacesAndNewlines), forType: .string)
            note = r.code == 0 ? "Copied." : r.err
          }
        }
        Text(
          "Keep it in your password manager: without it, nobody can read the backup, you included. It goes to "
            + "iCloud Drive/lifelog backup, encrypted (restic)."
        ).font(Brand.serif(11))
      }
      HStack {
        Button("Export recordings…") { Task { await archive("export") } }
        Button("Import an export…") { Task { await archive("import") } }
      }
      .disabled(busy)
      Text(
        "A folder with the archive, the audio and a manifest; keys stay on this Mac. An import goes only into an "
          + "install where nothing was recorded yet."
      ).font(Brand.serif(11))
    }
    Section("Voice summaries") {
      LabeledContent("ChatGPT", value: voice?.chatgpt == true ? "signed in" : "not signed in")
      if let login {
        Button("Cancel the ChatGPT sign-in") { login.terminate() }
      } else {
        Button(voice?.chatgpt == true ? "Sign in to ChatGPT again…" : "Sign in to ChatGPT…") {
          Task { await signInToChatGPT() }
        }
      }
      LabeledContent("Claude", value: voice?.claudeToken == true ? "token saved" : "no token")
      SecureField("Token from `claude setup-token`", text: $claudeToken)
      Button("Save the Claude token") {
        Task {
          await act(["voice", "key", "claudeToken"], input: claudeToken, done: "Claude token saved.")
          claudeToken = ""
        }
      }
      .disabled(claudeToken.isEmpty || claudeToken.contains(where: \.isWhitespace) || busy)
      Text(
        "Summaries run on your ChatGPT or Claude subscription, never an API key; your iPhone picks which. For Claude, "
          + "run `claude setup-token` in Terminal and paste the token it prints; it lasts a year."
      ).font(Brand.serif(11))
      if !note.isEmpty {
        Text(note).caption().textSelection(.enabled)
      }
    }
    .task { await load() }
    .onReceive(Timer.publish(every: 5, on: .main, in: .common).autoconnect()) { _ in
      Task { await readStatus() }
    }
  }

  private func load() async {
    await readStatus()
  }

  /// The status again; the switches take its values the first time it has them (until then they are disabled).
  private func readStatus() async {
    let loaded = voice?.speakers != nil
    voice = try? JSONDecoder().decode(VoiceStatus.self, from: Data(await Helper.run(["voice", "status"]).out.utf8))
    if !loaded, let s = voice?.speakers, let b = voice?.backups {
      speakers = s
      backups = b
    }
  }

  /// A switch that saves when he flips it (never when `load` sets it).
  private func saving(_ value: Binding<Bool>) -> Binding<Bool> {
    Binding(
      get: { value.wrappedValue },
      set: { on in
        value.wrappedValue = on
        Task { await saveToggles() }
      })
  }

  /// The two switches into the `voice` setting, then voice's jobs as they now say.
  private func saveToggles() async {
    guard let json = try? JSONSerialization.data(withJSONObject: ["voice": ["speakers": speakers, "backups": backups]])
    else { return }
    let r = await Helper.run(["settings", "set", String(decoding: json, as: UTF8.self)])
    guard r.code == 0 else {
      note = r.err
      return
    }
    await act(["voice", "start"], done: "Saved.")
  }

  /// One helper command, one at a time; what it said, or `done`, shows under the section.
  private func act(_ args: [String], input: String? = nil, done: String) async {
    busy = true
    let r = await Helper.run(args, input: input)
    busy = false
    let said = (r.code == 0 ? r.out : r.err).trimmingCharacters(in: .whitespacesAndNewlines)
    note = r.code == 0 && (said.isEmpty || said.hasPrefix("{")) ? done : said
    await readStatus()
  }

  private func archive(_ verb: String) async {
    let url: URL?
    if verb == "export" {
      let panel = NSSavePanel()
      panel.nameFieldStringValue = "Voice export \(Date().formatted(.iso8601.year().month().day()))"
      panel.canCreateDirectories = true
      url = panel.runModal() == .OK ? panel.url : nil
    } else {
      let panel = NSOpenPanel()
      panel.canChooseDirectories = true
      panel.canChooseFiles = false
      panel.message = "Choose a folder made by Export recordings…"
      url = panel.runModal() == .OK ? panel.url : nil
    }
    guard let url else { return }
    note = verb == "export" ? "Exporting…" : "Importing…"
    await act(["voice", verb, url.path], done: "Done.")
  }

  /// The Mac helper's own ChatGPT login in the browser (`life voice sign-in-chatgpt` becomes `codex login`); Cancel
  /// stops it, and so do 10 minutes.
  private func signInToChatGPT() async {
    let p = Helper.process(["voice", "sign-in-chatgpt"])
    p.standardOutput = FileHandle.nullDevice
    p.standardError = FileHandle.nullDevice
    do { try p.run() } catch {
      note = "The ChatGPT sign-in didn't start: \(error.localizedDescription)"
      return
    }
    login = p
    note = "Sign in to ChatGPT in your browser…"
    let deadline = Date.now.addingTimeInterval(600)
    while p.isRunning, Date.now < deadline { try? await Task.sleep(for: .milliseconds(500)) }
    if p.isRunning { p.terminate() }
    login = nil
    await readStatus()
    note = voice?.chatgpt == true ? "Signed in to ChatGPT." : "The ChatGPT sign-in didn't finish."
  }
}

/// The helper's `voice status`, decided there (`host/voice.ts`): its line, whether the server answers, the switches as
/// they apply, what is set up, and each job's log. The app only shows it. When voice's files can't be read, only the
/// line comes, saying why.
struct VoiceStatus: Decodable {
  let line: String
  let answering: Bool?
  let backups: Bool?
  let chatgpt: Bool?
  let claudeToken: Bool?
  let elevenLabsKey: Bool?
  let iCloud: Bool?
  let logs: [String: String]?
  let recorded: Bool?
  let speakers: Bool?
}
