import AppKit
import CryptoKit
import Foundation

/// remctl (github.com/viticci/remctl), Reminders for Life: the pinned release's disk image, checked against its
/// checksum, then its own installer ("Install RemCTL": signed, notarized, it asks for the Mac's password and walks
/// through its permissions). The app never installs remctl's files itself.
enum Remctl {
  static func installer(in mount: URL) -> URL? {
    (try? FileManager.default.contentsOfDirectory(at: mount, includingPropertiesForKeys: nil))?
      .first { $0.lastPathComponent.hasPrefix("Install RemCTL") }
  }

  static func install(_ release: Reminders.Release) async -> String {
    guard let url = URL(string: release.url) else { return "remctl: no release address" }
    let mount = FileManager.default.temporaryDirectory.appending(path: "RemCTL-\(release.version)")
    // Already mounted (an earlier try): its installer again, no second download.
    if let installer = installer(in: mount) {
      NSWorkspace.shared.open(installer)
      return "Finish remctl's installer, then turn Reminders on again."
    }
    do {
      let (file, _) = try await URLSession.shared.download(from: url)
      let data = try Data(contentsOf: file)
      let sum = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
      guard sum == release.sha256 else { return "remctl's download doesn't match its checksum: not installed" }
      let dmg = FileManager.default.temporaryDirectory.appending(path: "RemCTL-\(release.version).dmg")
      try? FileManager.default.removeItem(at: dmg)
      try FileManager.default.moveItem(at: file, to: dmg)
      let attach = Process()
      attach.executableURL = URL(fileURLWithPath: "/usr/bin/hdiutil")
      attach.arguments = ["attach", "-nobrowse", "-mountpoint", mount.path, dmg.path]
      try attach.run()
      attach.waitUntilExit()
      guard attach.terminationStatus == 0 else { return "remctl: its disk image would not open" }
      guard let installer = installer(in: mount) else { return "remctl: its disk image has no installer" }
      // The volume stays attached: the installer runs from it (macOS detaches it at the next restart).
      NSWorkspace.shared.open(installer)
      return "Finish remctl's installer, then turn Reminders on again."
    } catch {
      return "remctl: \(error.localizedDescription)"
    }
  }
}
