import Foundation
import QuietCore
import Testing

@Test func theServerGetsHashesNeverTokensAndListensOnLoopback() {
    let secrets = Secrets(
        macToken: "mac-token", deviceToken: "phone-token", readerToken: "reader-token", elevenLabsKey: "el")
    let env = Host.serverEnvironment(
        support: URL(filePath: "/tmp/lifelog-host"), secrets: secrets,
        server: URL(string: "https://mac.example.ts.net"))
    #expect(env["DATABASE_PATH"] == "/tmp/lifelog-host/archive.sqlite")
    #expect(env["AUDIO_DIR"] == "/tmp/lifelog-host/audio")
    #expect(env["LISTEN_HOST"] == "127.0.0.1")
    #expect(env["PUBLIC_BASE_URL"] == "https://mac.example.ts.net")
    #expect(env["DEVICE_TOKEN_HASH"] == Host.sha256Hex("phone-token"))
    #expect(env["ELEVENLABS_API_KEY"] == "el")
    #expect(env["OPENAI_API_KEY"] == nil, "no key, no variable")
    #expect(!env.values.contains { $0.contains("token") }, "no token in clear")
    // sha256("abc"), the standard test vector.
    #expect(Host.sha256Hex("abc") == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
}

@Test func mintingFillsOnlyTheMissingTokens() {
    let secrets = Host.minted(Secrets(macToken: "kept", claudeToken: "claude"))
    #expect(secrets.macToken == "kept")
    #expect(secrets.claudeToken == "claude")
    for token in [secrets.deviceToken, secrets.readerToken] {
        #expect(token?.wholeMatch(of: /[A-Za-z0-9_-]{43}/) != nil)
    }
    #expect(secrets.deviceToken != secrets.readerToken)
    #expect(Host.minted(secrets) == secrets, "minting twice changes nothing")
}

@Test func theTailnetNameComesFromTailscaleStatus() {
    let status = Data(#"{"Self": {"DNSName": "mac.example.ts.net."}, "Peer": {}}"#.utf8)
    #expect(Host.tailnetAddress(status: status)?.absoluteString == "https://mac.example.ts.net")
    #expect(Host.tailnetAddress(status: Data(#"{"Self": {"DNSName": ""}}"#.utf8)) == nil)
    #expect(Host.tailnetAddress(status: Data("not json".utf8)) == nil)
}

/// The phone reads this exact link (Kit's `PairingTests` checks the same string).
@Test func thePairingLinkIsTheOneThePhoneReads() throws {
    let link = try #require(
        Host.pairingLink(server: URL(string: "https://mac.example.ts.net")!, token: "abc_DEF-123-xyz_456"))
    #expect(link.absoluteString == "lifelog://pair?url=https://mac.example.ts.net&token=abc_DEF-123-xyz_456")
    #expect(Host.pairingLink(server: URL(string: "http://127.0.0.1:47613")!, token: "t") == nil, "HTTPS only")
}

@Test func theOwnersServerEnvGoesUnderHostsOwn() {
    let file = """
        # the owner's extras
        RESEND_API_KEY='re_123'
        export AUTH_SECRET="a secret with spaces"
        PORT=1
        APNS_PRIVATE_KEY='-----BEGIN PRIVATE KEY-----
        abc=
        -----END PRIVATE KEY-----'
        EMPTY=
        """
    let extra = Host.environmentFile(file)
    #expect(extra["RESEND_API_KEY"] == "re_123")
    #expect(extra["AUTH_SECRET"] == "a secret with spaces")
    #expect(extra["APNS_PRIVATE_KEY"] == "-----BEGIN PRIVATE KEY-----\nabc=\n-----END PRIVATE KEY-----")
    #expect(extra["EMPTY"] == "")
    #expect(extra["abc"] == nil, "a line inside a quoted value is not a key")
    let env = Host.serverEnvironment(
        support: URL(filePath: "/tmp/lifelog-host"), secrets: Secrets(elevenLabsKey: "el"), server: nil,
        build: "abc1234", extra: extra.merging(["BUILD_SHA": "stale"]) { $1 })
    #expect(env["RESEND_API_KEY"] == "re_123")
    #expect(env["PORT"] == String(Host.port), "Host's own win")
    #expect(env["BUILD_SHA"] == "abc1234", "the build Host was made from")
}

@Test func aPastedClaudeTokenIsOneWord() {
    #expect(Summaries.claudeToken("  sk-ant-oat01-abc\n") == "sk-ant-oat01-abc")
    #expect(Summaries.claudeToken(" \n") == nil)
    #expect(Summaries.claudeToken("sk-ant-oat01-abc sk-ant-oat01-def") == nil, "two pastes are no token")
    #expect(Summaries.codexLoginEnvironment["CODEX_HOME"] == Summaries.codexHome.path, "the helper's own login")
}

@Test func resticOnlyWhenBackupsAreOn() {
    let secrets = Host.minted(Secrets())
    let off = Host.serverEnvironment(support: URL(filePath: "/s"), secrets: secrets, server: nil)
    #expect(off["RESTIC_PASSWORD"] == nil && off["RESTIC_REPOSITORY"] == nil)
    let restic = Host.Restic(binary: URL(filePath: "/app/restic"), repository: URL(filePath: "/icloud/restic"))
    let on = Host.serverEnvironment(support: URL(filePath: "/s"), secrets: secrets, server: nil, restic: restic)
    #expect(on["RESTIC_PASSWORD"] == secrets.resticPassword && on["RESTIC_BINARY"] == "/app/restic")
    #expect(on["RESTIC_REPOSITORY"] == "/icloud/restic")
}

@Test func theTunnelKeepsItsTokenOffTheCommandLine() {
    #expect(
        Host.tunnelArguments() == [
            "tunnel", "--no-autoupdate", "--protocol", "http2", "--edge-ip-version", "4", "run", "--url",
            "http://127.0.0.1:47613",
        ])
    #expect(Host.domainAddress("lifelog.example.com")?.absoluteString == "https://lifelog.example.com")
    #expect(Host.domainAddress("https://lifelog.example.com/")?.absoluteString == "https://lifelog.example.com")
    #expect(Host.domainAddress("http://lifelog.example.com") == nil, "HTTPS only")
    #expect(Host.domainAddress("https://example.com/lifelog") == nil)
}

@Test func exportAndImportGetOnlyTheArchiveAndSayHowTheyEnded() {
    #expect(
        Host.archiveEnvironment(support: URL(filePath: "/s")) == [
            "DATABASE_PATH": "/s/archive.sqlite", "AUDIO_DIR": "/s/audio",
        ])
    let done = Host.archiveResult(
        "export", status: 0, output: "copying audio\n{\"ok\":true,\"files\":12,\"bytes\":2048}\n")
    #expect(done.ok && done.message.hasPrefix("Exported 12 files ("))
    let refused = Host.archiveResult(
        "import", status: 1, output: #"{"ok":false,"error":"this install isn't empty"}"#)
    #expect(!refused.ok && refused.message == "The import failed: this install isn't empty")
    let crashed = Host.archiveResult("import", status: 2, output: #"{"unexpected":1}"#)
    #expect(crashed.message == "The import failed: it stopped with status 2", "never raw JSON")
    #expect(Host.archiveResult("export", status: 1, output: "error: no space left").message.hasSuffix("no space left"))
}

@Test func speakerRecognitionSharesOneSecretWithTheServerOnLoopback() {
    let secrets = Host.minted(Secrets())
    #expect(secrets.identitySecret?.count == 43)
    let off = Host.serverEnvironment(support: URL(filePath: "/s"), secrets: secrets, server: nil)
    #expect(off["IDENTITY_URL"] == nil && off["IDENTITY_SECRET"] == nil, "off, the server skips naming")
    let leftover = Host.serverEnvironment(
        support: URL(filePath: "/s"), secrets: secrets, server: nil,
        extra: ["IDENTITY_URL": "http://old:8000", "IDENTITY_SECRET": "old", "RESTIC_PASSWORD": "old"])
    #expect(leftover["IDENTITY_URL"] == nil && leftover["RESTIC_PASSWORD"] == nil, "server.env can't turn them on")
    let on = Host.serverEnvironment(support: URL(filePath: "/s"), secrets: secrets, server: nil, identity: true)
    let service = Host.identityEnvironment(home: URL(filePath: "/s/identity"), secrets: secrets)
    #expect(on["IDENTITY_URL"] == "http://127.0.0.1:47614")
    #expect(on["IDENTITY_URL"] == "http://\(service["HOST"] ?? ""):\(service["PORT"] ?? "")", "where it listens")
    #expect(on["IDENTITY_SECRET"] == secrets.identitySecret && service["IDENTITY_SECRET"] == secrets.identitySecret)
    #expect(service["UV_PROJECT_ENVIRONMENT"] == "/s/identity/venv" && service["MODEL_DIR"] == "/s/identity/model")
    #expect(service["UV_PYTHON_PREFERENCE"] == "only-managed", "never a system Python an upgrade removes")
}
