import Foundation

/// A moment on the canonical timeline: Unix-epoch milliseconds of original capture, read from the Pendant RTC
/// and corrected for measured drift by `ClockModel`. Never derived from when a page was received.
public struct CaptureInstant: Hashable, Strideable, Sendable, Codable {
    public var millis: Int64

    public init(millis: Int64) {
        self.millis = millis
    }

    public func distance(to other: Self) -> Int64 { other.millis - millis }
    public func advanced(by millis: Int64) -> Self { Self(millis: self.millis + millis) }
    /// By value: `Strideable` would compare through `distance`, which overflows for an open range (`.min..<.max`).
    public static func < (lhs: Self, rhs: Self) -> Bool { lhs.millis < rhs.millis }
    public static func == (lhs: Self, rhs: Self) -> Bool { lhs.millis == rhs.millis }
}

extension CaptureInstant {
    /// Capture time is phone time: the Pendant's clock is set from the phone.
    public init(_ date: Date) {
        millis = Int64((date.timeIntervalSince1970 * 1000).rounded())
    }

    public var date: Date { Date(timeIntervalSince1970: Double(millis) / 1000) }
}

extension Range where Bound == CaptureInstant {
    /// Length in milliseconds.
    public var millis: Int64 { lowerBound.distance(to: upperBound) }
}

/// A stretch of capture time recorded in an audio file, starting `fileMillis` into it. The file plays linearly
/// through the stretch, so `file time = fileMillis + (instant - interval.lowerBound)`.
public struct FileRun: Sendable, Equatable, Codable {
    public var interval: Range<CaptureInstant>
    public var fileMillis: Int64

    public init(interval: Range<CaptureInstant>, fileMillis: Int64) {
        self.interval = interval
        self.fileMillis = fileMillis
    }
}

/// One `SetCurrentTime`. The RTC was set to `phoneMillis`, so pages from `firstPageIndex` on carry the reset clock.
/// `deviceMillisBeforeSet` is the RTC reading taken just before the set (pendant.md §3.6), when there was one.
public struct ClockSync: Sendable, Equatable, Codable {
    public var firstPageIndex: UInt64
    public var phoneMillis: Int64
    public var deviceMillisBeforeSet: Int64?

    public init(firstPageIndex: UInt64, phoneMillis: Int64, deviceMillisBeforeSet: Int64?) {
        self.firstPageIndex = firstPageIndex
        self.phoneMillis = phoneMillis
        self.deviceMillisBeforeSet = deviceMillisBeforeSet
    }
}

/// A recording pause or resume the Pendant confirmed by telemetry. `at` is phone time of the confirmation, which is
/// capture time because the Pendant clock is set from the phone. A pause says the microphone was off right there, so
/// segmentation splits a quiet stretch that contains it; a resume, confirmed after recording started, never splits.
/// A request nothing confirmed is never recorded.
public struct RecordingChange: Sendable, Equatable, Codable {
    public enum Kind: String, Sendable, Codable {
        case paused, resumed
    }

    public var kind: Kind
    public var at: CaptureInstant

    public init(_ kind: Kind, at: CaptureInstant) {
        self.kind = kind
        self.at = at
    }
}

/// The first page stamped after one of our clock sets: the page at `ClockSync.firstPageIndex`, as stored.
public struct ClockAnchor: Sendable, Equatable, Codable {
    public var pageIndex: UInt64
    public var boot: UInt64
    public var uptimeMillis: Int64
    public var deviceMillis: Int64

    public init(pageIndex: UInt64, boot: UInt64, uptimeMillis: Int64, deviceMillis: Int64) {
        self.pageIndex = pageIndex
        self.boot = boot
        self.uptimeMillis = uptimeMillis
        self.deviceMillis = deviceMillis
    }
}

/// Drift correction for one Pendant.
///
/// Between two syncs the RTC runs free. Right after sync `a` its error is zero; just before sync `b` it is
/// `b.deviceMillisBeforeSet - b.phoneMillis`. The error is assumed to grow linearly in between, so a page stamped
/// `t` is corrected by the error interpolated at `t`. A page belongs to an epoch by its page index, never by when
/// it arrived, so a page drained days late lands exactly where a prompt one would.
///
/// The open epoch (no later reading yet) is left uncorrected. Pages are normally drained only after reconnecting,
/// and the pre-sync reading is taken first, so their epoch is already closed when they arrive.
///
/// Within one boot the RTC is the uptime plus an offset that only a set changes (verified on the owner's Pendant:
/// constant to the millisecond over 8 hours). So `anchors` place every page of their boot, including pages stamped
/// by a stale clock restored at boot or by no clock at all (`captureInstant(of:)`).
public struct ClockModel: Sendable, Equatable {
    /// RTC values at or before 2020-01-01 mean the clock was never set (pendant.md §3.5).
    public static let earliestPlausibleMillis: Int64 = 1_577_836_800_000

    public let syncs: [ClockSync]
    public let anchors: [ClockAnchor]

    public init(syncs: [ClockSync], anchors: [ClockAnchor] = []) {
        self.syncs = syncs.sorted { $0.firstPageIndex < $1.firstPageIndex }
        self.anchors = anchors.sorted { $0.pageIndex < $1.pageIndex }
    }

    /// Capture time at which `page` was opened. A page with an anchor in its boot (the latest one at or before it,
    /// else the earliest after it) is timed by its uptime from that anchor; any other page by its own RTC value.
    /// `nil` when neither is trustworthy.
    /// ponytail: uptime is trusted across the whole boot; crystal drift over a long boot (ppm) is not corrected.
    public func captureInstant(of page: AudioPage) -> CaptureInstant? {
        guard let uptime = page.uptimeMillis else {
            return captureInstant(deviceMillis: page.deviceMillis, pageIndex: page.index)
        }
        // Same boot, and uptime runs the same way as the page index (a repeated boot number never matches).
        let boot = anchors.filter {
            $0.boot == page.boot && ($0.pageIndex <= page.index) == ($0.uptimeMillis <= uptime)
        }
        guard let anchor = boot.last(where: { $0.pageIndex <= page.index }) ?? boot.first else {
            return captureInstant(deviceMillis: page.deviceMillis, pageIndex: page.index)
        }
        return captureInstant(
            deviceMillis: anchor.deviceMillis + uptime - anchor.uptimeMillis, pageIndex: anchor.pageIndex)
    }

    /// Capture time of an RTC reading stamped on page `pageIndex`; `nil` when the RTC value is not trustworthy.
    public func captureInstant(deviceMillis: Int64, pageIndex: UInt64) -> CaptureInstant? {
        guard deviceMillis > Self.earliestPlausibleMillis else { return nil }
        let next = syncs.firstIndex { $0.firstPageIndex > pageIndex } ?? syncs.count
        guard next < syncs.count, let before = syncs[next].deviceMillisBeforeSet else {
            return CaptureInstant(millis: deviceMillis)
        }
        let closingError = Double(before - syncs[next].phoneMillis)
        // ponytail: before the first known sync the epoch start is unknown, so the closing error applies flat.
        var fraction = 1.0
        if next > 0 {
            let start = syncs[next - 1].phoneMillis
            if before > start {
                fraction = min(max(Double(deviceMillis - start) / Double(before - start), 0), 1)
            }
        }
        return CaptureInstant(millis: deviceMillis - Int64((closingError * fraction).rounded()))
    }
}

// MARK: Interval arithmetic on sorted, disjoint ranges

extension Array where Element == Range<CaptureInstant> {
    /// Sorted and disjoint, with overlapping or touching ranges joined and empty ones dropped.
    public func unioned() -> [Element] {
        var result: [Element] = []
        for range in sorted(by: { $0.lowerBound < $1.lowerBound }) where !range.isEmpty {
            if let last = result.last, range.lowerBound <= last.upperBound {
                result[result.count - 1] = last.lowerBound..<Swift.max(last.upperBound, range.upperBound)
            } else {
                result.append(range)
            }
        }
        return result
    }

    /// `self` minus `other`; both must be `unioned()`.
    public func subtracting(_ other: [Element]) -> [Element] {
        var result: [Element] = []
        var first = 0
        for range in self {
            while first < other.count, other[first].upperBound <= range.lowerBound { first += 1 }
            var cursor = range.lowerBound
            var index = first
            while index < other.count, other[index].lowerBound < range.upperBound {
                if other[index].lowerBound > cursor { result.append(cursor..<other[index].lowerBound) }
                cursor = Swift.max(cursor, other[index].upperBound)
                index += 1
            }
            if cursor < range.upperBound { result.append(cursor..<range.upperBound) }
        }
        return result
    }
}
