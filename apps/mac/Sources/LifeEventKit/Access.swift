import ApplicationServices
import Contacts
import EventKit
import Foundation
import Photos

// `life-eventkit access status|ask`: what an access card checks on the Mac (apps/server/src/host/mac-access.ts). Run by
// Life, a child of Life.app, so each status and prompt is Life.app's grant. `status` never prompts; `ask --of=<check>`
// shows that permission's prompt and waits for his answer. Full Disk Access and free space are read by Life itself, and
// System Settings' panes are opened by Life with `open`.

/// A status in Life's words: `done`, `missing` (never asked), or `refused`.
func accessStatuses() -> [String: String] {
  let photos: String
  switch PHPhotoLibrary.authorizationStatus(for: .readWrite) {
  case .authorized: photos = "done"
  case .notDetermined: photos = "missing"
  default: photos = "refused"
  }
  let contacts: String
  switch CNContactStore.authorizationStatus(for: .contacts) {
  case .authorized: contacts = "done"
  case .notDetermined: contacts = "missing"
  default: contacts = "refused"
  }
  let calendars: String
  switch EKEventStore.authorizationStatus(for: .event) {
  case .fullAccess: calendars = "done"
  case .notDetermined, .writeOnly: calendars = "missing"
  default: calendars = "refused"
  }
  // Accessibility has no refused: only System Settings turns it on.
  return [
    "accessibility": AXIsProcessTrusted() ? "done" : "missing",
    "calendars": calendars,
    "contacts": contacts,
    "photos": photos,
  ]
}

/// Shows `check`'s prompt and waits for his answer (Life gives up after its own limit).
func askAccess(_ check: String) {
  let answered = DispatchSemaphore(value: 0)
  let contactStore = CNContactStore()
  switch check {
  case "photos":
    PHPhotoLibrary.requestAuthorization(for: .readWrite) { _ in answered.signal() }
  case "contacts":
    contactStore.requestAccess(for: .contacts) { _, _ in answered.signal() }
  case "calendars":
    store.requestFullAccessToEvents { _, _ in answered.signal() }
  case "accessibility":
    // The system's alert, which opens the pane: nothing to wait for.
    let prompt = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
    _ = AXIsProcessTrustedWithOptions([prompt: true] as CFDictionary)
    return
  default:
    fail("no prompt for \(check)")
  }
  answered.wait()
}

func access(_ args: [String]) {
  switch args.first ?? "" {
  case "status": emit(accessStatuses())
  case "ask": askAccess(flags(Array(args.dropFirst())).named["of"] ?? "")
  default: fail("usage: life-eventkit access status|ask --of=<check>")
  }
}
