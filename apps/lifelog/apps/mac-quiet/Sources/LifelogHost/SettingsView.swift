import AppKit
import CoreImage.CIFilterBuiltins
import QuietCore
import ServiceManagement
import SwiftUI

/// Settings, and the first run's setup until lifelog is set up: the keys, how the phone reaches this Mac, then start
/// fresh or import an export, then pair the iPhone.
struct SettingsView: View {
    let host: HostModel
    @State private var keys = HostModel.Keys()
    @State private var settings = HostSettings()
    @State private var loginItem = SMAppService.mainApp.status == .enabled
    @State private var claudeToken = ""

    private var ready: Bool {
        !keys.elevenLabs.isEmpty
            && (settings.reach == .tailnet
                || (Host.domainAddress(settings.domain) != nil && !keys.cloudflare.isEmpty))
    }

    var body: some View {
        Form {
            Section("Transcription") {
                SecureField("ElevenLabs API key", text: $keys.elevenLabs)
                if let url = URL(string: "https://elevenlabs.io/app/developers/api-keys") {
                    Link("Get one at elevenlabs.io: Developers, then API keys", destination: url).font(.caption)
                }
                SecureField("OpenAI API key (optional)", text: $keys.openAI)
                Text("Search by meaning. Without it, search finds the exact words.")
                    .font(.caption).foregroundStyle(.secondary)
                Toggle("Recognize speakers by their voice", isOn: $settings.speakers)
                Text(
                    "Names the voices you've named before, on this Mac; installs about 630 MB once. Off, voices stay unnamed."
                )
                .font(.caption).foregroundStyle(.secondary)
            }
            summaries
            reaching
            if host.setUp {
                Section("Your iPhone") {
                    if host.status?.phoneHeartbeat?.receivedAt == nil {
                        PairingCode(host: host)
                    } else {
                        LabeledContent(
                            "Paired",
                            value: "last heard \(Host.ago(host.status?.phoneHeartbeat?.receivedAt, now: .now))")
                    }
                }
                backups
                Section("Your data") {
                    Button("Export everything…") { Task { await export() } }
                        .disabled(host.busy)
                    Button("Import an export…") { Task { await importExport() } }
                        .disabled(host.busy)
                    Text(
                        "A folder with the archive, the audio and a manifest. Keys and tokens stay on this Mac. An "
                            + "import goes only into an install where nothing was recorded yet."
                    )
                    .font(.caption).foregroundStyle(.secondary)
                }
                Section("Life") {
                    Button("Copy Life's lifelog settings") { host.copyReaderSettings() }
                        .disabled(host.server == nil)
                    Text("lifelog's address and a reader's token, for Life's Settings.")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Section {
                    // Read again after each change (`readLoginItem`).
                    Toggle(
                        "Open lifelog at login",
                        isOn: Binding(
                            get: { loginItem },
                            set: { on in
                                host.openAtLogin(on)
                                readLoginItem()
                            }))
                    Button("Save and restart lifelog") { Task { await host.apply(keys, settings) } }
                        .disabled(!ready || host.busy)
                    LabeledContent(
                        "Version",
                        value: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
                            ?? "dev")
                }
            } else {
                Section("Your recordings") {
                    Button("Start fresh") {
                        Task {
                            await host.startFresh(keys, settings)
                            readLoginItem()
                        }
                    }
                    .disabled(!ready || host.busy)
                    Button("Import an export…") { Task { await importExport() } }
                        .disabled(!ready || host.busy)
                    Text(
                        "Import a folder made by Export everything…, on this Mac or another. lifelog then opens at "
                            + "login; Settings can turn that off."
                    )
                    .font(.caption).foregroundStyle(.secondary)
                }
            }
            ForEach(host.problems, id: \.self) { Text($0).foregroundStyle(.red) }
            if !host.progress.isEmpty {
                Text(host.progress).font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
            }
        }
        .formStyle(.grouped)
        .frame(width: 520)
        .frame(minHeight: 560)
        .onAppear {
            keys = .init(
                elevenLabs: host.secrets.elevenLabsKey ?? "", openAI: host.secrets.openAIKey ?? "",
                cloudflare: host.secrets.cloudflareToken ?? "")
            settings = host.settings
        }
    }

    private var reaching: some View {
        Section("How your phone reaches this Mac") {
            Picker("Through", selection: $settings.reach) {
                Text("On my tailnet (Tailscale)").tag(Host.Reach.tailnet)
                Text("My own domain (Cloudflare tunnel)").tag(Host.Reach.domain)
            }
            .pickerStyle(.radioGroup)
            switch settings.reach {
            case .tailnet:
                switch host.tailnet {
                case .serving(let url):
                    LabeledContent("Address", value: url.absoluteString).textSelection(.enabled)
                case .signedOut:
                    Text("Tailscale is on this Mac but not signed in: open it, sign in, then check again.")
                        .font(.caption)
                case .missing:
                    Text(
                        "Install Tailscale on this Mac and on your iPhone, and sign in to the same account on both. "
                            + "It's free for personal use."
                    )
                    .font(.caption)
                    if let url = URL(string: "https://tailscale.com/download") {
                        Link("Download Tailscale", destination: url).font(.caption)
                    }
                }
                Button("Check again") { Task { await host.checkTailscale() } }
            case .domain:
                TextField("Address", text: $settings.domain, prompt: Text("https://lifelog.example.com"))
                SecureField("Tunnel token", text: $keys.cloudflare)
                Text(
                    "In Cloudflare's Zero Trust dashboard, Networks, Tunnels: create a tunnel, copy its token, and "
                        + "route your address to http://127.0.0.1:\(Host.port). lifelog runs the tunnel."
                )
                .font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    /// The subscription the summaries run on, and the helper's sign-in to each. No API key: they wait for it.
    private var summaries: some View {
        Section("Summaries") {
            if host.setUp {
                Picker(
                    "Run on",
                    selection: Binding(
                        get: { host.status?.switches?.engine.flatMap(LLMEngine.init) },
                        set: { engine in if let engine { Task { await host.choose(engine) } } })
                ) {
                    Text("Claude").tag(LLMEngine?.some(.claude))
                    Text("ChatGPT").tag(LLMEngine?.some(.codex))
                }
            }
            LabeledContent("ChatGPT", value: host.codexSignedIn ? "signed in" : "not signed in")
            if host.signingIn {
                Button("Cancel the ChatGPT sign-in") { host.cancelSignIn() }
            } else {
                Button(host.codexSignedIn ? "Sign in to ChatGPT again…" : "Sign in to ChatGPT…") {
                    Task { await host.signInToChatGPT() }
                }
            }
            LabeledContent("Claude", value: host.secrets.claudeToken == nil ? "no token" : "token saved")
            if Summaries.claudeBinary() == nil, let url = URL(string: "https://code.claude.com/docs/en/setup") {
                Link("Claude needs Claude Code on this Mac: install it", destination: url).font(.caption)
            }
            SecureField("Token from `claude setup-token`", text: $claudeToken)
            Button("Save the Claude token") {
                Task {
                    await host.saveClaudeToken(claudeToken)
                    claudeToken = ""
                }
            }
            .disabled(claudeToken.isEmpty || host.busy)
            Text(
                "Summaries run on your ChatGPT or Claude subscription, never an API key. For Claude, run `claude "
                    + "setup-token` in Terminal and paste the token it prints; it lasts a year."
            )
            .font(.caption).foregroundStyle(.secondary)
        }
    }

    private var backups: some View {
        Section("Backups") {
            let iCloud = FileManager.default.fileExists(atPath: HostModel.iCloud.path)
            Toggle("Back up to iCloud Drive every day", isOn: $settings.backups)
                .disabled(!iCloud)
            if !iCloud {
                Text("Turn on iCloud Drive in System Settings first.").font(.caption)
            } else if host.settings.backups {
                LabeledContent(
                    "Last backup",
                    value: host.status?.backup?.restic?.lastError.map { "failed: \($0)" }
                        ?? Host.ago(host.status?.backup?.restic?.lastSnapshotAt, now: .now))
                LabeledContent("Repository", value: HostModel.backupRepository.path).textSelection(.enabled)
                Button("Copy the backup password") { host.copy(host.secrets.resticPassword ?? "") }
                Text(
                    "Keep it in your password manager: without it, nobody can read the backup, you included. It "
                        + "goes to iCloud Drive/lifelog backup, encrypted (restic)."
                )
                .font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    /// macOS's answer is the truth: read again after anything that registers lifelog to open at login.
    private func readLoginItem() {
        loginItem = SMAppService.mainApp.status == .enabled
    }

    private func importExport() async {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.message = "Choose a folder made by Export everything…"
        guard panel.runModal() == .OK, let url = panel.url else { return }
        await host.importExport(from: url, keys, settings)
        readLoginItem()
    }

    private func export() async {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = "lifelog export \(Date.now.formatted(.iso8601.year().month().day()))"
        panel.canCreateDirectories = true
        guard panel.runModal() == .OK, let url = panel.url else { return }
        await host.export(to: url)
    }
}

/// The QR code of the pairing link, for the iPhone's Camera, and the link itself.
struct PairingCode: View {
    let host: HostModel

    var body: some View {
        VStack(spacing: 12) {
            if let link = host.pairingLink, let image = qrCode(link.absoluteString) {
                Image(nsImage: image).interpolation(.none).resizable().frame(width: 220, height: 220)
                Text("Open the Camera on your iPhone and point it at this code. lifelog asks before it pairs.")
                    .multilineTextAlignment(.center)
                Text(link.absoluteString).font(.caption.monospaced()).textSelection(.enabled).lineLimit(2)
            } else {
                Text(
                    host.settings.reach == .tailnet
                        ? "Pairing needs Tailscale on this Mac and on the iPhone."
                        : "Pairing needs your https address in Settings.")
            }
        }
        .frame(maxWidth: .infinity)
    }

    private func qrCode(_ text: String) -> NSImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(text.utf8)
        guard let output = filter.outputImage?.transformed(by: CGAffineTransform(scaleX: 8, y: 8)) else { return nil }
        let rep = NSCIImageRep(ciImage: output)
        let image = NSImage(size: rep.size)
        image.addRepresentation(rep)
        return image
    }
}
