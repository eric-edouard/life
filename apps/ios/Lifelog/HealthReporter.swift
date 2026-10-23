import Capture
import Foundation
import Health
import MetricKit
import OSLog
import ServerAPI
import SwiftUI
import Synchronization
import UIKit

/// Every error shown to the owner passes through here, so the daily read of the diagnostics sees it too: it is
/// reported as an `app_error` (where it was caught, its type and code, a shortened message and the call stack) and the
/// text to show comes back: one short sentence, never the raw description (that goes to diagnostics only). Repeats
/// within the hour are one report with a count (`ErrorReporter`). Cancellation is not an error, a network that gave no
/// answer (`URLError.isTransient`) is the connection status's to show, not a bug, and nothing is reported before
/// `HealthReporter.start()` (a simulated Pendant never starts it). Every one, reported or not, is logged on the phone
/// (`log stream --predicate 'subsystem == "<bundle id>"'`), so a failure the owner never saw is findable.
nonisolated func report(_ error: any Error, file: StaticString = #fileID, line: UInt = #line) -> String {
    Logger(subsystem: Bundle.main.bundleIdentifier ?? "lifelog", category: "error")
        .error(
            "\(file, privacy: .public):\(line) \(String(reflecting: type(of: error)), privacy: .public) \((error as NSError).code) \(String(describing: error), privacy: .private)"
        )
    var status: Int?
    var serverCode: String?
    let text: String
    switch error {
    case ServerClient.ClientError.notPaired:
        text = SyncStore.notPaired
    case ServerClient.ClientError.server(let code, let errorCode, _):
        (status, serverCode, text) = (code, errorCode, "The server couldn't do that right now.")
    case let error as URLError where error.isTransient:
        text = "Can't reach the server."
    case let error as PlaybackStore.Unavailable:
        text = error.description
    default:
        text = "Something went wrong."
    }
    let cancelled = error is CancellationError || (error as? URLError)?.code == .cancelled
    let offline = (error as? URLError)?.isTransient == true
    guard !cancelled, !offline, HealthReporter.reporting.load(ordering: .relaxed) else { return text }
    let addresses = Thread.callStackReturnAddresses.map(\.uintValue)
    let bridged = error as NSError
    let appError = DiagnosticUpload.AppError(
        file: "\(file)", line: Int(line), type: String(reflecting: type(of: error)), domain: bridged.domain,
        code: bridged.code, httpStatus: status, serverCode: serverCode, message: String(describing: error))
    Task { @concurrent in
        guard (try? await HealthReporter.errors.record(appError, returnAddresses: addresses)) == true else { return }
        await HealthReporter.deliver(HealthReporter.outbox)
    }
    return text
}

/// A step of a chain the owner relies on (docs/decisions.md, "Events trace each chain"), such as a Live
/// Activity push arriving: logged with `Logger` under the name's first part ("activity", "push",
/// "processing") and sent as an app event (`EventReporter`), read with `bun run events`. Ids, states and counts only,
/// never content. Sent only once `HealthReporter.start()` ran, like errors.
nonisolated func appEvent(_ name: String, _ fields: [String: String] = [:]) {
    Logger(subsystem: Bundle.main.bundleIdentifier ?? "lifelog", category: String(name.prefix { $0 != "." }))
        .notice("\(name, privacy: .public) \(fields.description, privacy: .public)")
    guard HealthReporter.reporting.load(ordering: .relaxed) else { return }
    Task { @concurrent in
        guard (try? await HealthReporter.events.record(name, fields)) == true else { return }
        await HealthReporter.deliver(HealthReporter.eventOutbox)
    }
}

extension View {
    /// Times how long `screen` took to show its rows the first time it appeared in this launch: a `screen.shown` event
    /// with the milliseconds from appearing to `ready`, read with `bun run events screen`. Screens render local rows
    /// first (docs/architecture.md), so this should stay well under a second, offline too.
    func timesFirstRender(_ screen: String, ready: Bool, rows: Int) -> some View {
        onAppear { ScreenTiming.appeared(screen) }
            .onChange(of: ready, initial: true) { _, ready in if ready { ScreenTiming.shown(screen, rows: rows) } }
    }
}

enum ScreenTiming {
    /// Read first in `AppDelegate.init`.
    static let launched = ContinuousClock.now
    private static var appeared: [String: ContinuousClock.Instant] = [:]
    private static var shown: Set<String> = []

    static func appeared(_ screen: String) {
        if appeared[screen] == nil { appeared[screen] = .now }
    }

    static func shown(_ screen: String, rows: Int) {
        guard let start = appeared[screen], shown.insert(screen).inserted else { return }
        let millis = { (duration: Duration) in String(Int(duration / .milliseconds(1))) }
        appEvent(
            "screen.shown",
            [
                "screen": screen, "ms": millis(.now - start), "sinceLaunch": millis(.now - launched),
                "rows": String(rows),
            ])
    }
}

/// The first characters of a push token, enough to match it with the server's `apns.sent`.
nonisolated func tokenPrefix(_ token: Data) -> String {
    token.prefix(4).map { String(format: "%02x", $0) }.joined()
}

/// Remote crash, error and health reporting (docs/providers.md), so the owner learns about crashes, errors and capture
/// trouble while away from the Mac: MetricKit diagnostics and daily metrics, errors the owner saw (`report`), and a
/// capture-health heartbeat at most every 6 h while the app runs plus at once on notable events and each change of the
/// Pendant's connection or recording. Everything goes
/// through `HealthOutbox`, off the main actor: capture never waits on it, and nothing is lost when the server can't be
/// reached.
final class HealthReporter {
    private static let scheduleKey = "heartbeatSchedule"

    nonisolated fileprivate static let outbox = HealthOutbox(
        directory: URL.applicationSupportDirectory.appending(path: "lifelog/outbox", directoryHint: .isDirectory))
    nonisolated fileprivate static let errors = ErrorReporter(outbox: outbox, build: build)
    nonisolated fileprivate static let eventOutbox = HealthOutbox(
        directory: URL.applicationSupportDirectory.appending(path: "lifelog/events", directoryHint: .isDirectory))
    nonisolated fileprivate static let events = EventReporter(outbox: eventOutbox)
    nonisolated fileprivate static let reporting = Atomic(false)
    private let metrics = MetricManager()
    private var schedule: HeartbeatSchedule
    private var started: Bool { Self.reporting.load(ordering: .relaxed) }

    init() {
        schedule = Self.saved ?? HeartbeatSchedule()
    }

    /// The schedule as last saved, by this launch or one before.
    static var saved: HeartbeatSchedule? {
        UserDefaults.standard.data(forKey: scheduleKey).flatMap {
            try? JSONDecoder().decode(HeartbeatSchedule.self, from: $0)
        }
    }

    /// Call once at launch, in the foreground or a background relaunch: MetricKit hands over its reports while the app
    /// runs. Not called for a simulated Pendant, so its made-up status never reaches the server.
    func start() {
        guard !started else { return }
        Self.reporting.store(true, ordering: .relaxed)
        UIDevice.current.isBatteryMonitoringEnabled = true
        let (outbox, metrics) = (Self.outbox, metrics)
        Task { @concurrent in
            for await report in metrics.diagnosticReports {
                guard let upload = Self.upload(report) else { continue }
                try? await outbox.enqueue(upload, path: "diagnostics", urgent: upload.kind == .crash)
                await Self.deliver(outbox)
            }
        }
        Task { @concurrent in
            for await report in metrics.metricReports {
                guard let upload = Self.upload(report) else { continue }
                try? await outbox.enqueue(upload, path: "diagnostics", urgent: false)
                await Self.deliver(outbox)
            }
        }
        flush()
    }

    /// Each capture status update: sends a heartbeat when one is due (`HeartbeatSchedule`).
    func update(
        _ status: CaptureStatus, connectionSince: Date, lastContact: Date?, phoneFreeBytes: Int64?, wakeLog: WakeLog
    ) {
        guard started else { return }
        let before = schedule
        let reason = schedule.due(status, phoneFreeBytes: phoneFreeBytes, now: .now)
        if schedule != before {
            UserDefaults.standard.set(try? JSONEncoder().encode(schedule), forKey: Self.scheduleKey)
        }
        guard let reason else { return }
        let device = UIDevice.current
        let charging: Bool? =
            switch device.batteryState {
            case .charging, .full: true
            case .unplugged: false
            default: nil
            }
        let phone = Heartbeat.Phone(
            batteryLevel: device.batteryLevel < 0 ? nil : Double(device.batteryLevel), charging: charging,
            freeBytes: phoneFreeBytes, lowPowerMode: ProcessInfo.processInfo.isLowPowerModeEnabled)
        let heartbeat = Heartbeat(
            reason: reason, at: .now, build: Self.build, status: status, connectionSince: connectionSince,
            lastContact: lastContact, phone: phone, wakeLog: wakeLog)
        let outbox = Self.outbox
        Task { @concurrent in
            try? await outbox.enqueue(heartbeat, path: "health/heartbeat", urgent: reason != .periodic)
            await Self.deliver(outbox)
        }
    }

    /// Retries what is waiting, for example when the app comes forward.
    func flush() {
        guard started else { return }
        let (outbox, events) = (Self.outbox, Self.eventOutbox)
        Task { @concurrent in
            await Self.deliver(outbox)
            await Self.deliver(events)
        }
    }

    /// Non-urgent reports wait out Low Power Mode. A refusal for the request itself drops the report; anything else
    /// (offline, no token yet, the server down) is retried later.
    @concurrent nonisolated fileprivate static func deliver(_ outbox: HealthOutbox) async {
        let client = ServerClient.production
        await outbox.flush(lowPowerMode: ProcessInfo.processInfo.isLowPowerModeEnabled) { path, body in
            do {
                try await client.postReport(path, json: body)
                return .delivered
            } catch ServerClient.ClientError.server(let status, _, _) where ServerClient.refuses(status) {
                return .rejected
            } catch {
                return .retry
            }
        }
    }

    // MARK: MetricKit

    /// Copies a MetricKit diagnostic field for field; `DiagnosticUpload` decides what leaves the phone. Launch and memory
    /// diagnostics aren't sent.
    nonisolated private static func upload(_ report: DiagnosticReport) -> DiagnosticUpload? {
        let detail: RawDiagnostic<CallStackFrame>.Detail
        let tree: CallStackTree
        switch report.result {
        case .crash(let crash):
            tree = crash.callStackTree
            detail = .crash(
                .init(
                    exceptionType: crash.exceptionType, exceptionCode: crash.exceptionCode, signal: crash.signal,
                    terminationReason: crash.terminationReason?.rawValue,
                    terminationCategory: crash.terminationCategory?.rawValue,
                    virtualMemoryRegionInfo: crash.virtualMemoryRegionInfo,
                    objcException: crash.exceptionReason.map {
                        .init(
                            name: $0.exceptionName, type: $0.exceptionType, className: $0.className,
                            formatString: $0.formatString, composedMessage: $0.composedMessage, arguments: $0.arguments)
                    }))
        case .hang(let hang):
            tree = hang.callStackTree
            detail = .hang(seconds: hang.hangDuration.converted(to: .seconds).value)
        case .cpuException(let cpu):
            tree = cpu.callStackTree
            detail = .cpuException(cpuSeconds: cpu.totalCPUTime.converted(to: .seconds).value)
        case .diskWriteException(let disk):
            tree = disk.callStackTree
            detail = .diskWriteException(bytes: disk.totalBytesWritten.converted(to: .bytes).value)
        default:
            return nil
        }
        let environment = report.environment
        let os = environment.osVersion
        return DiagnosticUpload(
            RawDiagnostic(
                detail: detail,
                build: BuildInfo(
                    appVersion: environment.applicationVersion, appBuild: environment.applicationBuildVersion,
                    os: "\(os.platform) \(os.number) (\(os.buildNumber))", device: environment.deviceType),
                begin: report.timeRange.start, end: report.timeRange.end,
                threads: tree.callStackThreads.map {
                    .init(attributed: $0.threadAttributed ?? false, rootFrames: Array($0.rootFrames))
                },
                binaryNames: tree.binaryInfo.mapValues(\.name)))
    }

    /// A day of metrics, numbers only: the longest interval MetricKit reports, which is the whole day.
    nonisolated private static func upload(_ report: MetricReport) -> DiagnosticUpload? {
        guard let day = report.intervalEntries.max(by: { $0.duration < $1.duration }),
            let environment = report.environment
        else { return nil }
        func seconds(_ value: Measurement<UnitDuration>) -> Double { value.converted(to: .seconds).value }
        func bytes(_ value: Measurement<UnitInformationStorage>) -> Double { value.converted(to: .bytes).value }
        var metrics: [String: Double] = [:]
        for value in day.values {
            switch value {
            case .totalForegroundTime(let metric): metrics["foregroundSeconds"] = seconds(metric.value)
            case .totalBackgroundTime(let metric): metrics["backgroundSeconds"] = seconds(metric.value)
            case .totalBackgroundAudioTime(let metric): metrics["backgroundAudioSeconds"] = seconds(metric.value)
            case .cpuTime(let metric): metrics["cpuSeconds"] = seconds(metric.value)
            case .peakMemory(let metric): metrics["peakMemoryBytes"] = bytes(metric.value)
            case .logicalDiskWrites(let metric): metrics["logicalWriteBytes"] = bytes(metric.value)
            case .cpuInstructionsCount(let metric): metrics["cpuInstructions"] = Double(metric.value)
            case .totalWiFiUpload(let metric): metrics["wifiUploadBytes"] = bytes(metric.value)
            case .totalWiFiDownload(let metric): metrics["wifiDownloadBytes"] = bytes(metric.value)
            case .totalCellularUpload(let metric): metrics["cellularUploadBytes"] = bytes(metric.value)
            case .totalCellularDownload(let metric): metrics["cellularDownloadBytes"] = bytes(metric.value)
            case .totalBackgroundLocationTime(let metric): metrics["backgroundLocationSeconds"] = seconds(metric.value)
            // Without `reducedAccuracy`: the app never asks for it, and reading it stops the app at launch where
            // MetricKit lacks it.
            case .locationActivityTime(let time):
                metrics["locationBestForNavigationSeconds"] = seconds(time.bestAccuracyForNavigation)
                metrics["locationBestSeconds"] = seconds(time.bestAccuracy)
                metrics["locationTenMetersSeconds"] = seconds(time.tenMeters)
                metrics["locationHundredMetersSeconds"] = seconds(time.oneHundredMeter)
                metrics["locationKilometerSeconds"] = seconds(time.oneKilometer)
                metrics["locationThreeKilometersSeconds"] = seconds(time.threeKilometers)
            // The work marked with `mxSignpost` on `OSLog.work`: what each costs a day.
            case .signpostInterval(let interval) where interval.signpostCategory == OSLog.workCategory:
                let name = interval.signpostName
                metrics["signpost_\(name)_count"] = Double(interval.totalCount)
                if let cpu = interval.cpuTime { metrics["signpost_\(name)_cpuSeconds"] = seconds(cpu) }
                if let writes = interval.logicalWrites { metrics["signpost_\(name)_writeBytes"] = bytes(writes) }
            case .hangTime(let metric): metrics["hangs"] = Double(metric.histogram.buckets.reduce(0) { $0 + $1.count })
            case .foregroundTermination(let exits):
                metrics["foregroundExitsNormal"] = Double(exits.normalTerminationCount)
                metrics["foregroundExitsMemoryLimit"] = Double(exits.memoryLimitTerminationCount)
                metrics["foregroundExitsBadAccess"] = Double(exits.badAccessTerminationCount)
                metrics["foregroundExitsAbnormal"] = Double(exits.abnormalTerminationCount)
                metrics["foregroundExitsIllegalInstruction"] = Double(exits.illegalInstructionTerminationCount)
                metrics["foregroundExitsWatchdog"] = Double(exits.watchdogTerminationCount)
            case .backgroundTermination(let exits):
                metrics["backgroundExitsNormal"] = Double(exits.normalTerminationCount)
                metrics["backgroundExitsMemoryLimit"] = Double(exits.memoryLimitTerminationCount)
                metrics["backgroundExitsHighCPU"] = Double(exits.highCPUTerminationCount)
                metrics["backgroundExitsSystemPressure"] = Double(exits.systemPressureTerminationCount)
                metrics["backgroundExitsBadAccess"] = Double(exits.badAccessTerminationCount)
                metrics["backgroundExitsAbnormal"] = Double(exits.abnormalTerminationCount)
                metrics["backgroundExitsIllegalInstruction"] = Double(exits.illegalInstructionTerminationCount)
                metrics["backgroundExitsWatchdog"] = Double(exits.watchdogTerminationCount)
                metrics["backgroundExitsFileLock"] = Double(exits.fileLockTerminationCount)
                metrics["backgroundExitsTaskTimeout"] = Double(exits.taskTimeoutTerminationCount)
            default: break
            }
        }
        let os = environment.osVersion
        return DiagnosticUpload(
            metrics: metrics,
            build: BuildInfo(
                appVersion: environment.latestApplicationVersion, appBuild: environment.applicationBuildVersion,
                os: "\(os.platform) \(os.number) (\(os.buildNumber))", device: environment.deviceType),
            begin: report.timeRange.start, end: report.timeRange.end)
    }

    // MARK: This build

    /// The running build, with its executable's UUID so the right dSYM can be kept for symbolication.
    nonisolated private static let build: BuildInfo = {
        let info = Bundle.main.infoDictionary ?? [:]
        var system = utsname()
        uname(&system)
        let machine = withUnsafeBytes(of: system.machine) { String(decoding: $0.prefix { $0 != 0 }, as: UTF8.self) }
        return BuildInfo(
            appVersion: info["CFBundleShortVersionString"] as? String ?? "?",
            appBuild: info["CFBundleVersion"] as? String ?? "?",
            os: "iOS \(ProcessInfo.processInfo.operatingSystemVersionString)",
            device: ProcessInfo.processInfo.environment["SIMULATOR_MODEL_IDENTIFIER"] ?? machine,
            // The image this code is linked into: the app's executable.
            executableUUID: machOUUID(#dsohandle))
    }()
}

extension CallStackFrame: @retroactive StackFrame {}

extension OSLog {
    nonisolated static let workCategory = "work"
    /// Work that runs outside the driver's runs, marked with `mxSignpost` so MetricKit reports its daily CPU and writes.
    /// A signpost's name becomes part of a metric key: letters, digits and underscores, at most 43 characters, or the
    /// server refuses the whole day's metrics.
    nonisolated static let work = MetricManager.logHandle(category: workCategory)
}
