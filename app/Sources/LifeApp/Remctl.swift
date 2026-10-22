import AppKit
import CryptoKit
import Foundation

/// remctl (github.com/viticci/remctl), Reminders for Life: the pinned release's disk image, checked against its
/// checksum, then its own installer ("Install RemCTL": signed, notarized, it asks for the Mac's password and walks
/// through its permissions). The app never installs remctl's files itself.
enum Remctl {
  static func install(_ release: Reminders.Release) async -> String {
    guard let url = URL(string: release.url) else { return "remctl: no release address" }
    do {
      let (file, _) = try await URLSession.shared.download(from: url)
      let data = try Data(contentsOf: file)
      let sum = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
      guard sum == release.sha256 else { return "remctl's download doesn't match its checksum: not installed" }
      let dmg = FileManager.default.temporaryDirectory.appending(path: "RemCTL-\(release.version).dmg")
      try? FileManager.default.removeItem(at: dmg)
      try FileManager.default.moveItem(at: file, to: dmg)
      let mount = FileManager.default.temporaryDirectory.appending(path: "RemCTL-\(release.version)")
      let attach = Process()
      attach.executableURL = URL(fileURLWithPath: "/usr/bin/hdiutil")
      attach.arguments = ["attach", "-nobrowse", "-mountpoint", mount.path, dmg.path]
      try attach.run()
      attach.waitUntilExit()
      guard attach.terminationStatus == 0,
        let installer = try FileManager.default.contentsOfDirectory(at: mount, includingPropertiesForKeys: nil)
          .first(where: { $0.lastPathComponent.hasPrefix("Install RemCTL") })
      else { return "remctl: its disk image has no installer" }
      NSWorkspace.shared.open(installer)
      return "Finish remctl's installer, then turn Reminders on again."
    } catch {
      return "remctl: \(error.localizedDescription)"
    }
  }
}
