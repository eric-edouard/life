import Foundation

/// A server-sent event stream, byte by byte: the `data:` lines of an event joined by newlines, ended by a blank line.
/// Comments (`:`) and other fields are skipped; an event cut before its blank line is never given.
public struct SSEParser: Sendable {
    private var line: [UInt8] = []
    private var data: [String] = []

    public init() {}

    /// The data of the event this byte completed, if it did.
    public mutating func feed(_ byte: UInt8) -> String? {
        guard byte == UInt8(ascii: "\n") else {
            line.append(byte)
            return nil
        }
        var text = String(decoding: line, as: UTF8.self)
        line.removeAll(keepingCapacity: true)
        if text.hasSuffix("\r") { text.removeLast() }
        if text.isEmpty {
            defer { data = [] }
            return data.isEmpty ? nil : data.joined(separator: "\n")
        }
        if text.hasPrefix("data:") {
            let value = text.dropFirst(5)
            data.append(String(value.first == " " ? value.dropFirst() : value))
        }
        return nil
    }

    public mutating func feed(_ bytes: some Sequence<UInt8>) -> [String] {
        bytes.compactMap { feed($0) }
    }
}
