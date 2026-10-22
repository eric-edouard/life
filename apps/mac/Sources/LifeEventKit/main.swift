import EventKit
import Foundation

// life-eventkit: the Past calendar on an Apple calendar, through EventKit, for an install without Google
// (apps/server/src/memory/past-events.ts, `calendar held|create|delete`). Life's events carry their moment and hash in their URL,
// `life://moment/<id>?hash=<hash>`, as Google's carry them in private properties. Reminders is remctl's, never this.

let store = EKEventStore()

func fail(_ message: String) -> Never {
  FileHandle.standardError.write(Data("\(message)\n".utf8))
  exit(1)
}

func emit(_ value: Any) {
  let data = (try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])) ?? Data("{}".utf8)
  FileHandle.standardOutput.write(data)
}

/** Formats that don't follow the Mac's locale or calendar (a Buddhist-calendar Mac would misread them). */
let isoDay: DateFormatter = {
  let f = DateFormatter()
  f.locale = Locale(identifier: "en_US_POSIX")
  f.calendar = Calendar(identifier: .gregorian)
  f.dateFormat = "yyyy-MM-dd"
  return f
}()
let isoTime: ISO8601DateFormatter = {
  let f = ISO8601DateFormatter()
  f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
  return f
}()
/** An instant as Life sends it (`2026-10-22T09:00:00.000Z`), with or without its fraction. */
func instant(_ s: String) -> Date? {
  isoTime.date(from: s) ?? ISO8601DateFormatter().date(from: s)
}

/// The flags Life sends, `--name=value` or a bare `--name`; anything else is the positional rest.
func flags(_ args: [String]) -> (named: [String: String], rest: [String]) {
  var named: [String: String] = [:]
  var rest: [String] = []
  for a in args {
    if a.hasPrefix("--") {
      let body = String(a.dropFirst(2))
      if let eq = body.firstIndex(of: "=") {
        named[String(body[..<eq])] = String(body[body.index(after: eq)...])
      } else {
        named[body] = ""
      }
    } else {
      rest.append(a)
    }
  }
  return (named, rest)
}

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

var args = Array(CommandLine.arguments.dropFirst())
guard args.first == "calendar" else { fail("usage: life-eventkit calendar held|create|delete") }
args.removeFirst()
let sub = args.isEmpty ? "" : args.removeFirst()
eventsAccess()
let (named, rest) = flags(args)
let cal = eventCalendar(named["calendar"] ?? "")
switch sub {
case "held":
  let until = isoDay.date(from: named["until"] ?? "") ?? Date()
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
  e.title = named["summary"] ?? ""
  e.notes = named["description"]
  e.location = named["location"]
  e.availability = .free
  e.isAllDay = named["all-day"] != nil
  let parse = { (s: String) in instant(s) ?? isoDay.date(from: String(s.prefix(10))) }
  guard let start = parse(named["from"] ?? ""), let end = parse(named["to"] ?? "") else { fail("from and to are dates") }
  e.startDate = start
  // Life's all-day end is the day after (exclusive); EventKit's is the last day itself.
  e.endDate = e.isAllDay ? end.addingTimeInterval(-1) : end
  var url = URLComponents()
  url.scheme = "life"
  url.host = "moment"
  url.path = "/\(named["moment"] ?? "")"
  url.queryItems = [URLQueryItem(name: "hash", value: named["hash"] ?? "")]
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
