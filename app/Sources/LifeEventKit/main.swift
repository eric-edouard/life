import CryptoKit
import EventKit
import Foundation

// life-eventkit: Apple Reminders and Calendar through EventKit, for a friend's install.
// Reminders answer as remctl does for the commands Life uses (src/reminders/remctl.ts), so no remctl is needed. What
// EventKit can't do: sections (none; a `--private` step comes back as a partial), and Recently Deleted (a removal is
// final; `deleted` lists nothing, `restore` fails; a recurrence is not set). Reminders' ids are UUIDs: each one's number
// is derived from it, as remctl's are numbers, and its deepLink holds the UUID. The answers' shapes are remctl's
// (src/reminders/answers.json).
// `calendar held|create|delete` is the Past calendar (src/memory/past.ts): Life's events carry their moment and hash in
// their URL, `life://moment/<id>?hash=<hash>`, as Google's carry them in private properties.

let store = EKEventStore()

func fail(_ message: String) -> Never {
  FileHandle.standardError.write(Data("\(message)\n".utf8))
  exit(1)
}

func emit(_ value: Any) {
  let data = (try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])) ?? Data("{}".utf8)
  FileHandle.standardOutput.write(data)
}

// MARK: numbers for UUIDs

/** A reminder's number: the first 13 hex digits of its UUID's SHA-256 (under 2^52, exact in JavaScript). */
func number(_ uuid: String) -> Int {
  let digest = SHA256.hash(data: Data(uuid.utf8)).map { String(format: "%02x", $0) }.joined()
  return Int(digest.prefix(13), radix: 16) ?? 0
}

// MARK: access and reading

func access() {
  let done = DispatchSemaphore(value: 0)
  var granted = false
  store.requestFullAccessToReminders { ok, _ in
    granted = ok
    done.signal()
  }
  done.wait()
  if !granted { fail("no access to Reminders: allow Life in System Settings > Privacy & Security > Reminders") }
}

func reminders(in calendars: [EKCalendar]?, completed: Bool) -> [EKReminder] {
  let done = DispatchSemaphore(value: 0)
  var found: [EKReminder] = []
  let predicate = completed
    ? store.predicateForReminders(in: calendars)
    : store.predicateForIncompleteReminders(withDueDateStarting: nil, ending: nil, calendars: calendars)
  store.fetchReminders(matching: predicate) { r in
    found = r ?? []
    done.signal()
  }
  done.wait()
  return found
}

/** Formats that don't follow the Mac's locale or calendar (a Buddhist-calendar Mac would misread them). */
func posix(_ format: String) -> DateFormatter {
  let f = DateFormatter()
  f.locale = Locale(identifier: "en_US_POSIX")
  f.calendar = Calendar(identifier: .gregorian)
  f.dateFormat = format
  return f
}
let isoDay = posix("yyyy-MM-dd")
/** remctl's wall time: local, no zone. */
let localTime = posix("yyyy-MM-dd'T'HH:mm:ss")
let isoTime: ISO8601DateFormatter = {
  let f = ISO8601DateFormatter()
  f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
  return f
}()
/** An instant as Life sends it (`2026-10-22T09:00:00.000Z`), with or without its fraction. */
func instant(_ s: String) -> Date? {
  isoTime.date(from: s) ?? ISO8601DateFormatter().date(from: s)
}

func json(_ r: EKReminder) -> [String: Any] {
  var o: [String: Any] = [
    "completed": r.isCompleted,
    "deepLink": "x-apple-reminderkit://REMCDReminder/\(r.calendarItemIdentifier)",
    "id": number(r.calendarItemIdentifier),
    "list": r.calendar?.title ?? NSNull(),
    "title": r.title ?? "",
  ]
  if let notes = r.notes { o["notes"] = notes }
  if let c = r.creationDate { o["createdDate"] = isoTime.string(from: c) }
  if let due = r.dueDateComponents, let date = Calendar.current.date(from: due) {
    let allDay = due.hour == nil
    o["allDay"] = allDay
    o["dueDate"] = allDay ? isoDay.string(from: date) : localTime.string(from: date)
  }
  o["priority"] = ["none", "high", "high", "high", "high", "medium", "low", "low", "low", "low"][min(r.priority, 9)]
  if r.hasAlarms { o["alarms"] = r.alarms?.count ?? 0 }
  return o
}

func calendar(named title: String) -> EKCalendar? {
  store.calendars(for: .reminder).first { $0.title == title }
}

/** The reminder with this number: found among all of them (an edit is rare; no table to keep). */
func reminder(_ n: String) -> EKReminder {
  guard let i = Int(n),
    let r = reminders(in: nil, completed: true).first(where: { number($0.calendarItemIdentifier) == i })
  else { fail("no reminder \(n)") }
  return r
}

// MARK: writing

/// The flags remctl takes, `--name=value` or `--name value`; what follows `--` is the positional rest.
func flags(_ args: [String]) -> (named: [String: [String]], rest: [String], isPrivate: Bool) {
  var named: [String: [String]] = [:]
  var rest: [String] = []
  var isPrivate = false
  var i = 0
  while i < args.count {
    let a = args[i]
    if a == "--" {
      rest += args[(i + 1)...]
      break
    }
    if a == "--private" {
      isPrivate = true
    } else if a.hasPrefix("--") {
      let body = String(a.dropFirst(2))
      if let eq = body.firstIndex(of: "=") {
        named[String(body[..<eq]), default: []].append(String(body[body.index(after: eq)...]))
      } else {
        named[body, default: []].append("")
      }
    } else {
      rest.append(a)
    }
    i += 1
  }
  return (named, rest, isPrivate)
}

func due(_ value: String) -> DateComponents? {
  if value == "clear" { return nil }
  let parts = value.split(separator: " ")
  let day = parts.first.map(String.init) ?? value
  guard let date = isoDay.date(from: String(day.prefix(10))) else { return nil }
  var c = Calendar.current.dateComponents([.year, .month, .day], from: date)
  if parts.count > 1 || value.contains("T") {
    let time = value.contains("T") ? value.split(separator: "T")[1] : parts[1]
    let hm = time.split(separator: ":").compactMap { Int($0) }
    c.hour = hm.first
    c.minute = hm.count > 1 ? hm[1] : 0
  }
  return c
}

func apply(_ f: [String: [String]], to r: EKReminder) {
  if let t = f["title"]?.last { r.title = t }
  if let n = f["notes"]?.last { r.notes = n.isEmpty ? nil : n }
  if let d = f["due"]?.last { r.dueDateComponents = due(d) }
  if let p = f["priority"]?.last { r.priority = ["high": 1, "medium": 5, "low": 9][p] ?? 0 }
  if let a = f["alarm"]?.last, let c = due(a), let date = Calendar.current.date(from: c) {
    r.addAlarm(EKAlarm(absoluteDate: date))
  }
  if let l = f["list"]?.last, let cal = calendar(named: l) { r.calendar = cal }
}

/// A `--private` step EventKit can't take (sections, urgent, subtasks, links): the change is made, the step is not.
func answer(_ r: EKReminder, isPrivate: Bool, recurrence: Bool) -> [String: Any] {
  var o = json(r)
  // As remctl answers an add or an edit: the number, and the deepLink's UUID as `id`.
  o["numericId"] = o["id"]
  o["id"] = r.calendarItemIdentifier
  if isPrivate || recurrence {
    o["status"] = "partial"
    o["message"] = recurrence ? "a recurrence needs remctl" : "sections, urgent and subtasks need remctl"
  }
  return o
}

// MARK: commands

var args = Array(CommandLine.arguments.dropFirst())
var command = args.isEmpty ? "" : args.removeFirst()
args.removeAll { $0 == "--json" }

// MARK: the Past calendar

func eventsAccess() {
  let done = DispatchSemaphore(value: 0)
  var granted = false
  store.requestFullAccessToEvents { ok, _ in
    granted = ok
    done.signal()
  }
  done.wait()
  if !granted { fail("no access to Calendar: allow Life in System Settings > Privacy & Security > Calendars") }
}

func eventCalendar(_ title: String) -> EKCalendar {
  guard let c = store.calendars(for: .event).first(where: { $0.title == title }) else { fail("no calendar \(title)") }
  return c
}

func moment(of e: EKEvent) -> (id: String, hash: String)? {
  guard let url = e.url, url.scheme == "life", url.host == "moment",
    let parts = URLComponents(url: url, resolvingAgainstBaseURL: false)
  else { return nil }
  let id = String(url.path.dropFirst())
  let hash = parts.queryItems?.first { $0.name == "hash" }?.value ?? ""
  return (id, hash)
}

if command == "calendar" {
  eventsAccess()
  let sub = args.isEmpty ? "" : args.removeFirst()
  let (named, rest, _) = flags(args)
  let cal = eventCalendar(named["calendar"]?.last ?? "")
  switch sub {
  case "held":
    let until = isoDay.date(from: named["until"]?.last ?? "") ?? Date()
    let from = Calendar.current.date(byAdding: .year, value: -30, to: until) ?? until
    var held: [[String: String]] = []
    // EventKit searches at most four years at a time.
    var start = from
    while start < until {
      let end = min(Calendar.current.date(byAdding: .year, value: 4, to: start) ?? until, until)
      for e in store.events(matching: store.predicateForEvents(withStart: start, end: end, calendars: [cal])) {
        if let m = moment(of: e) { held.append(["hash": m.hash, "id": e.eventIdentifier, "moment": m.id]) }
      }
      start = end
    }
    emit(held)
  case "create":
    let e = EKEvent(eventStore: store)
    e.calendar = cal
    e.title = named["summary"]?.last ?? ""
    e.notes = named["description"]?.last
    e.location = named["location"]?.last
    e.availability = .free
    e.isAllDay = named["all-day"] != nil
    let parse = { (s: String) in instant(s) ?? isoDay.date(from: String(s.prefix(10))) }
    guard let start = parse(named["from"]?.last ?? ""), let end = parse(named["to"]?.last ?? "") else { fail("from and to are dates") }
    e.startDate = start
    e.endDate = end
    var url = URLComponents()
    url.scheme = "life"
    url.host = "moment"
    url.path = "/\(named["moment"]?.last ?? "")"
    url.queryItems = [URLQueryItem(name: "hash", value: named["hash"]?.last ?? "")]
    e.url = url.url
    do { try store.save(e, span: .thisEvent, commit: true) } catch { fail("create: \(error.localizedDescription)") }
    emit(["id": e.eventIdentifier ?? ""])
  case "delete":
    guard let e = store.event(withIdentifier: rest.first ?? "") else { fail("no event \(rest.first ?? "")") }
    do { try store.remove(e, span: .thisEvent, commit: true) } catch { fail("delete: \(error.localizedDescription)") }
    emit(["status": "ok"])
  default:
    fail("unknown calendar command \(sub)")
  }
  exit(0)
}

access()
let (named, rest, isPrivate) = flags(args)

switch command {
case "lists":
  emit(store.calendars(for: .reminder).enumerated().map { i, c in
    ["id": i + 1, "isGroup": false, "title": c.title] as [String: Any]
  })
case "show":
  let cals = store.calendars(for: .reminder)
  let i = Int(named["list-id"]?.last ?? "") ?? 0
  guard i >= 1, i <= cals.count else { fail("no list \(i)") }
  emit(reminders(in: [cals[i - 1]], completed: named["completed"] != nil).map(json))
case "sections":
  emit([String: [String]]())
case "list-info":
  guard let cal = calendar(named: rest.first ?? "") else { fail("no list \(rest.first ?? "")") }
  // A list on this Mac only can't be shared; EventKit can't tell for an iCloud one, so it counts as shared (remctl.ts
  // `unshared` fails closed: Life adds nothing there unasked and reads nothing back from it).
  if cal.source.sourceType == .local {
    emit(["sharees": [Any](), "shared": false, "title": cal.title])
  } else {
    emit(["shared": NSNull(), "title": cal.title])
  }
case "info":
  emit(json(reminder(rest.first ?? "")))
case "add":
  let r = EKReminder(eventStore: store)
  r.title = rest.joined(separator: " ")
  r.calendar = named["list"]?.last.flatMap(calendar(named:)) ?? store.defaultCalendarForNewReminders()
  apply(named, to: r)
  do { try store.save(r, commit: true) } catch { fail("add: \(error.localizedDescription)") }
  emit(answer(r, isPrivate: isPrivate, recurrence: named["recurrence"] != nil))
case "edit":
  let r = reminder(rest.first ?? "")
  apply(named, to: r)
  do { try store.save(r, commit: true) } catch { fail("edit: \(error.localizedDescription)") }
  emit(answer(r, isPrivate: isPrivate, recurrence: named["recurrence"] != nil))
case "done", "undone":
  for n in rest {
    let r = reminder(n)
    r.isCompleted = command == "done"
    do { try store.save(r, commit: true) } catch { fail("\(command): \(error.localizedDescription)") }
  }
  emit(["status": "ok"])
case "delete":
  let r = reminder(rest.first ?? "")
  do { try store.remove(r, commit: true) } catch { fail("delete: \(error.localizedDescription)") }
  emit(["status": "ok"])
case "deleted":
  emit(["items": [Any]()])
case "restore":
  fail("restore needs remctl: EventKit has no Recently Deleted")
default:
  fail("unknown command \(command)")
}
