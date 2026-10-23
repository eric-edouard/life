import Foundation
import MachO

/// One MetricKit diagnostic (crash, hang, CPU or disk-write exception), a day of its metrics, or an error the owner saw,
/// as the server takes it (openapi `DiagnosticUpload`). Call stacks are flattened depth-first in MetricKit's own nesting
/// with each frame's binary UUID, address and offset, which is what `atos` needs against the build's dSYM.
public struct DiagnosticUpload: Codable, Sendable, Equatable {
    public enum Kind: String, Codable, Sendable {
        case crash, hang, metrics
        case cpuException = "cpu_exception"
        case diskWriteException = "disk_write_exception"
        case appError = "app_error"
    }

    /// An error the owner saw: where it was caught, what it was, and its message cut to `messageLimit`.
    public struct AppError: Codable, Sendable, Equatable {
        static let messageLimit = 300

        var file: String
        var line: Int
        /// The Swift type, "ServerAPI.ServerClient.ClientError".
        var type: String
        var domain: String
        var code: Int
        /// An API error's status and the server's `Error.error`.
        var httpStatus: Int?
        var serverCode: String?
        var message: String
        /// Repeats within the hour (`ErrorReporter`).
        var count = 1

        public init(
            file: String, line: Int, type: String, domain: String, code: Int, httpStatus: Int?, serverCode: String?,
            message: String
        ) {
            (self.file, self.line, self.type, self.domain, self.code) = (file, line, type, domain, code)
            (self.httpStatus, self.serverCode) = (httpStatus, serverCode)
            self.message = String(message.prefix(Self.messageLimit))
        }

        /// Repeats of one error share it: the same place, type and code.
        var key: String { "\(file):\(line) \(type) \(domain) \(code) \(httpStatus ?? 0) \(serverCode ?? "")" }
    }

    public struct Binary: Codable, Sendable, Equatable {
        var name: String
        var uuid: String
    }

    public struct Frame: Codable, Sendable, Equatable {
        /// A frame at depth d+1 is a sub-frame of the closest frame above it at depth d.
        var depth: Int
        var binaryName: String?
        var binaryUUID: String?
        var address: UInt64?
        var offsetIntoBinaryTextSegment: UInt64?
        var sampleCount: Int?
    }

    public struct CallStack: Codable, Sendable, Equatable {
        var threadAttributed: Bool
        var frames: [Frame]
    }

    public struct ObjCException: Codable, Sendable, Equatable {
        var name: String
        var type: String
        var className: String
        /// The format string from the code that raised it, never the composed message or its arguments.
        var formatString: String
    }

    public struct Crash: Codable, Sendable, Equatable {
        var exceptionType: Int?
        var exceptionCode: UInt64?
        var signal: Int?
        var terminationReason: String?
        var terminationCategory: String?
        var objcException: ObjCException?
    }

    /// Frames past this across all stacks are dropped (`truncated`), keeping a crash with every thread well under the
    /// server's 1 MB limit.
    public static let frameBudget = 4000
    /// Free text from the system is cut to this; the server takes 1000.
    static let textLimit = 500

    public var id = UUID()
    public var kind: Kind
    public var build: BuildInfo
    public var begin: Date
    public var end: Date
    var binaries: [Binary] = []
    var callStacks: [CallStack] = []
    var crash: Crash?
    /// A hang's duration, or a CPU exception's CPU time.
    var durationSeconds: Double?
    var bytesWritten: Double?
    /// A day of metrics, numbers only: seconds, bytes, counts.
    var metrics: [String: Double]?
    var error: AppError?
    var truncated = false

    /// An error the owner saw, with the call stack where it was caught: `returnAddresses` innermost first, as
    /// `Thread.callStackReturnAddresses` gives them, resolved to binary and offset like MetricKit's frames.
    init(_ error: AppError, returnAddresses: [UInt], build: BuildInfo, begin: Date, end: Date) {
        kind = .appError
        self.error = error
        self.build = build
        self.begin = begin
        self.end = end
        var names: [String: String] = [:]
        let frames = returnAddresses.prefix(Self.errorFrameLimit).enumerated().map { depth, address in
            var frame = Frame(depth: depth, address: UInt64(address))
            var info = Dl_info()
            if dladdr(UnsafeRawPointer(bitPattern: address), &info) != 0, let base = info.dli_fbase {
                frame.binaryName = info.dli_fname.map { URL(filePath: String(cString: $0)).lastPathComponent }
                frame.binaryUUID = machOUUID(base)
                frame.offsetIntoBinaryTextSegment = UInt64(address - UInt(bitPattern: base))
                if let uuid = frame.binaryUUID { names[uuid] = frame.binaryName }
            }
            return frame
        }
        binaries = names.map { Binary(name: $0.value, uuid: $0.key) }.sorted { $0.name < $1.name }
        callStacks = [CallStack(threadAttributed: true, frames: frames)]
        truncated = returnAddresses.count > Self.errorFrameLimit
    }

    static let errorFrameLimit = 64

    /// A day of MetricKit metrics.
    public init(metrics: [String: Double], build: BuildInfo, begin: Date, end: Date) {
        kind = .metrics
        self.metrics = metrics
        self.build = build
        self.begin = begin
        self.end = end
    }

    /// The one place that decides what of a diagnostic leaves the phone. Dropped: the Objective-C exception's
    /// composed message and arguments (they may hold any app data) and the virtual-memory region description.
    public init<F: StackFrame>(_ raw: RawDiagnostic<F>) {
        build = raw.build
        begin = raw.begin
        end = raw.end
        switch raw.detail {
        case .crash(let crash):
            kind = .crash
            self.crash = Crash(
                exceptionType: crash.exceptionType, exceptionCode: crash.exceptionCode, signal: crash.signal,
                terminationReason: crash.terminationReason.map { String($0.prefix(Self.textLimit)) },
                terminationCategory: crash.terminationCategory,
                objcException: crash.objcException.map {
                    ObjCException(
                        name: $0.name, type: $0.type, className: $0.className,
                        formatString: String($0.formatString.prefix(Self.textLimit)))
                })
        case .hang(let seconds):
            kind = .hang
            durationSeconds = seconds
        case .cpuException(let cpuSeconds):
            kind = .cpuException
            durationSeconds = cpuSeconds
        case .diskWriteException(let bytes):
            kind = .diskWriteException
            bytesWritten = bytes
        }
        binaries = raw.binaryNames.map { Binary(name: $0.value, uuid: $0.key.uuidString) }.sorted { $0.name < $1.name }
        var budget = Self.frameBudget
        // The attributed thread first, so it survives the budget.
        for thread in raw.threads.sorted(by: { $0.attributed && !$1.attributed }) {
            guard budget > 0 else {
                truncated = true
                break
            }
            var frames: [Frame] = []
            var pending = thread.rootFrames.reversed().map { ($0, 0) }
            while let (frame, depth) = pending.popLast() {
                guard budget > 0 else {
                    truncated = true
                    break
                }
                budget -= 1
                frames.append(
                    Frame(
                        depth: depth, binaryName: frame.binaryUUID.flatMap { raw.binaryNames[$0] },
                        binaryUUID: frame.binaryUUID?.uuidString, address: frame.address,
                        offsetIntoBinaryTextSegment: frame.offsetIntoBinaryTextSegment, sampleCount: frame.sampleCount))
                pending += frame.subFrames.reversed().map { ($0, depth + 1) }
            }
            callStacks.append(CallStack(threadAttributed: thread.attributed, frames: frames))
        }
    }
}

/// A call-stack frame as MetricKit's `CallStackFrame` has it; the app conforms that type, tests their own.
public protocol StackFrame: Sendable {
    associatedtype SubFrames: BidirectionalCollection where SubFrames.Element == Self
    var binaryUUID: UUID? { get }
    var address: UInt64? { get }
    var offsetIntoBinaryTextSegment: UInt64? { get }
    var sampleCount: Int? { get }
    var subFrames: SubFrames { get }
}

/// A MetricKit diagnostic as plain values, copied field for field by the app, including what must not leave the phone,
/// so `DiagnosticUpload(_:)` alone decides what is sent and can be tested without MetricKit.
public struct RawDiagnostic<Frame: StackFrame>: Sendable {
    public struct ObjCException: Sendable {
        public var name, type, className, formatString, composedMessage: String
        public var arguments: [String]

        public init(
            name: String, type: String, className: String, formatString: String, composedMessage: String,
            arguments: [String]
        ) {
            (self.name, self.type, self.className) = (name, type, className)
            (self.formatString, self.composedMessage, self.arguments) = (formatString, composedMessage, arguments)
        }
    }

    public struct Crash: Sendable {
        public var exceptionType: Int?
        public var exceptionCode: UInt64?
        public var signal: Int?
        public var terminationReason: String?
        public var terminationCategory: String?
        public var virtualMemoryRegionInfo: String?
        public var objcException: ObjCException?

        public init(
            exceptionType: Int?, exceptionCode: UInt64?, signal: Int?, terminationReason: String?,
            terminationCategory: String?, virtualMemoryRegionInfo: String?, objcException: ObjCException?
        ) {
            (self.exceptionType, self.exceptionCode, self.signal) = (exceptionType, exceptionCode, signal)
            (self.terminationReason, self.terminationCategory) = (terminationReason, terminationCategory)
            (self.virtualMemoryRegionInfo, self.objcException) = (virtualMemoryRegionInfo, objcException)
        }
    }

    public enum Detail: Sendable {
        case crash(Crash)
        case hang(seconds: Double)
        case cpuException(cpuSeconds: Double)
        case diskWriteException(bytes: Double)
    }

    public struct Thread: Sendable {
        public var attributed: Bool
        public var rootFrames: [Frame]

        public init(attributed: Bool, rootFrames: [Frame]) {
            self.attributed = attributed
            self.rootFrames = rootFrames
        }
    }

    public var detail: Detail
    public var build: BuildInfo
    public var begin: Date
    public var end: Date
    public var threads: [Thread]
    public var binaryNames: [UUID: String]

    public init(
        detail: Detail, build: BuildInfo, begin: Date, end: Date, threads: [Thread], binaryNames: [UUID: String]
    ) {
        (self.detail, self.build, self.begin, self.end) = (detail, build, begin, end)
        (self.threads, self.binaryNames) = (threads, binaryNames)
    }
}

/// The `LC_UUID` load command of the 64-bit Mach-O image whose header is at `header`: its dSYM's UUID.
public func machOUUID(_ header: UnsafeRawPointer) -> String? {
    var command = header.advanced(by: MemoryLayout<mach_header_64>.size)
    for _ in 0..<header.loadUnaligned(as: mach_header_64.self).ncmds {
        let load = command.loadUnaligned(as: load_command.self)
        if load.cmd == LC_UUID { return UUID(uuid: command.loadUnaligned(as: uuid_command.self).uuid).uuidString }
        command = command.advanced(by: Int(load.cmdsize))
    }
    return nil
}
