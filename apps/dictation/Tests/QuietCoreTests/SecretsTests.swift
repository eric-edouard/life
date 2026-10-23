import Foundation
import QuietCore
import Testing

private func folder() throws -> URL {
    let url = FileManager.default.temporaryDirectory.appending(path: "secrets-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    return url
}

private func mode(_ url: URL) throws -> Int {
    try #require(try FileManager.default.attributesOfItem(atPath: url.path)[.posixPermissions] as? Int)
}

@Test func savesAnOwnerOnlyFileAndReadsItTrimmed() throws {
    let file = try folder().appending(path: "sub/secrets.json")
    #expect(try Secrets.load(from: file) == Secrets(), "no file, no secrets")
    try Secrets(macToken: " mac\n", claudeToken: "claude").save(to: file)
    #expect(try mode(file) == 0o600 && mode(file.deletingLastPathComponent()) == 0o700)
    #expect(try Secrets.load(from: file) == Secrets(macToken: "mac", claudeToken: "claude"))
}

@Test func refusesAFileOthersCanRead() throws {
    let file = try folder().appending(path: "secrets.json")
    try Secrets(macToken: "mac").save(to: file)
    try FileManager.default.setAttributes([.posixPermissions: 0o640], ofItemAtPath: file.path)
    #expect(throws: Secrets.Unsafe.self) { try Secrets.load(from: file) }
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
    #expect(try Secrets.load(from: file).macToken == "mac")
}

@Test func savingKeepsTheOtherSecretAndTheMode() throws {
    let file = try folder().appending(path: "secrets.json")
    try Secrets(macToken: "mac").save(to: file)
    var secrets = try Secrets.load(from: file)
    secrets.claudeToken = "claude"
    try secrets.save(to: file)
    #expect(try Secrets.load(from: file) == Secrets(macToken: "mac", claudeToken: "claude"))
    #expect(try mode(file) == 0o600)
}
