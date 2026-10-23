import Foundation
import Testing

@testable import PendantProtocol

// Omi's golden fixtures are synthetic: their "frames" sit in audio field 1 (debug PCM), not the real Opus field 4.
// We use them for framing, reassembly and robustness, and check our strict field-4 rule with hand-built chunks.

private struct Fixture: Decodable {
    var packets: [String]
}

private struct EncoderVector: Decodable {
    var name: String
    var messageIndex: UInt64
    var requestId: Int64
    var hex: String
    var timestampMs: UInt64?
    var upToIndex: UInt64?
}

private func fixture<T: Decodable>(_ name: String, as type: T.Type = Fixture.self) throws -> T {
    let url = try #require(Bundle.module.url(forResource: name, withExtension: "json", subdirectory: "Fixtures/omi"))
    return try JSONDecoder().decode(T.self, from: Data(contentsOf: url))
}

extension Data {
    init(hex: String) {
        let digits = Array(hex.utf8)
        self.init(
            stride(from: 0, to: digits.count - 1, by: 2).compactMap {
                UInt8(String(decoding: digits[$0...$0 + 1], as: UTF8.self), radix: 16)
            })
    }

    var hex: String { map { String(format: "%02x", $0) }.joined() }
}

/// Decodes single-fragment packets through the whole RX path.
private func decode(_ packets: [String]) throws -> PendantMessage? {
    var reassembler = Reassembler()
    var payload: Data?
    for packet in packets { payload = try reassembler.accept(Fragment(decoding: Data(hex: packet))) ?? payload }
    return try payload.map { try PendantMessage(decoding: $0) }
}

private func page(_ message: PendantMessage?) throws -> StorageBuffer {
    guard case .storageBuffer(let buffer) = try #require(message).content else {
        Issue.record("not a storage buffer")
        throw ProtocolError.missingField("storage_buffer")
    }
    return buffer
}

@Suite struct CommandEncoding {
    @Test func omiGoldenVectors() throws {
        struct File: Decodable { var vectors: [EncoderVector] }
        for vector in try fixture("encoders", as: File.self).vectors {
            let command: PendantCommand =
                switch vector.name {
                case "msg6_set_current_time": .setCurrentTime(unixMillis: try #require(vector.timestampMs))
                case "msg7_ack_12345": .acknowledge(throughIndex: try #require(vector.upToIndex))
                case "msg21_get_device_status": .getDeviceStatus
                case "msg8_batch_on": .setDownloadMode(.download)
                case "msg8_record_to_flash": .setDownloadMode(.recordOnly)
                default: .setDownloadMode(.live)
                }
            let fragment = Fragment(
                index: vector.messageIndex, payload: command.serverCommand(requestID: vector.requestId))
            #expect(fragment.encoded.hex == vector.hex, "\(vector.name)")
        }
    }

    @Test(arguments: [
        (PendantCommand.startRecording, "080710001801220a8a0100f2010408081000"),
        (.stopRecording, "080810001801220a920100f2010408091000"),
        (.setLEDBrightness(0), "080910001801220cd201020800f20104080a1000"),
        (.setLEDBrightness(50), "080910001801220cd201020832f20104080a1000"),
        (.getDeviceInfo, "080a1000180122097200f20104080b1000"),
    ])
    func researchVectors(command: PendantCommand, hex: String) {
        let index: UInt64 =
            switch command {
            case .startRecording: 7
            case .stopRecording: 8
            case .getDeviceInfo: 10
            default: 9
            }
        let fragment = Fragment(index: index, payload: command.serverCommand(requestID: Int64(index) + 1))
        #expect(fragment.encoded.hex == hex)
    }

    @Test func encoderNumbersFromZeroAndOne() throws {
        var encoder = CommandEncoder()
        let first = encoder.encode(.setCurrentTime(unixMillis: 1_750_000_000_000))
        #expect(first.bytes.hex == "080010001801221032070880b883a1f732f2010408011000")
        #expect(first.requestID == 1)
        let second = encoder.encode(.getDeviceStatus)
        #expect(second.requestID == 2)
        #expect(try Fragment(decoding: second.bytes).index == 1)
    }

    @Test func commandsRoundTripForTheSimulator() throws {
        let commands: [PendantCommand] = [
            .setCurrentTime(unixMillis: 42), .acknowledge(throughIndex: 12_345), .setDownloadMode(.download),
            .setDownloadMode(.recordOnly), .getDeviceStatus, .startRecording, .stopRecording, .setLEDBrightness(30),
            .getDeviceInfo,
        ]
        for command in commands {
            let decoded = try PendantCommand.decode(command.serverCommand(requestID: 9))
            #expect(decoded.command == command)
            #expect(decoded.requestID == 9)
        }
    }
}

@Suite struct InboundFixtures {
    @Test(arguments: [
        ("single_fragment_audio_page", UInt64(100), UInt64(1_750_000_000_000)),
        ("three_fragments_out_of_order", 101, 1_750_000_001_600),
        ("diagnostic_page_no_audio", 102, 1_750_000_003_200),
        ("nested_audio_containers", 103, 1_750_000_004_800),
        ("invalid_toc_interleaved", 104, 1_750_000_006_400),
        ("audio_page_zero_frames", 106, 1_750_000_009_600),
        ("fixed64_fields_page", 108, 1_750_000_012_800),
    ])
    func pagesDecode(name: String, index: UInt64, timestamp: UInt64) throws {
        let buffer = try page(decode(fixture(name).packets))
        #expect(buffer.index == index)
        #expect(buffer.session == 7)
        #expect(buffer.error == nil)
        let flash = try FlashPage(decoding: try #require(buffer.flashPage))
        #expect(flash.timestampMillis == timestamp)
        // Synthetic frames live in debug field 1, so the strict field-4 rule finds no Opus.
        #expect(flash.opusPackets.isEmpty)
    }

    @Test func diagnosticPageCarriesStorageSessionMarker() throws {
        let buffer = try page(decode(fixture("diagnostic_page_no_audio").packets))
        let flash = try FlashPage(decoding: try #require(buffer.flashPage))
        #expect(flash.chunks.first?.storage == StorageStatus(didStartSession: true, didStopSession: false))
    }

    @Test func overflowingChunkLengthFailsTheFlashPageOnly() throws {
        let buffer = try page(decode(fixture("overflow_varint_length").packets))
        #expect(buffer.index == 107)
        #expect(throws: ProtocolError.truncated) { try FlashPage(decoding: buffer.flashPage ?? Data()) }
    }

    @Test func groupWireTypeIsRejected() throws {
        let buffer = try page(decode(fixture("unknown_wiretype_page").packets))
        #expect(buffer.index == 109)
        #expect(throws: ProtocolError.unsupportedWireType(3)) { try FlashPage(decoding: buffer.flashPage ?? Data()) }
    }

    @Test func truncatedEnvelopeIsATypedError() throws {
        let packet = try fixture("truncated_trailing_field").packets[0]
        #expect(throws: ProtocolError.truncated) { try Fragment(decoding: Data(hex: packet)) }
    }

    @Test func deviceStatusStorageState() throws {
        let message = try #require(try decode(fixture("device_status").packets))
        guard case .deviceStatus(let status) = message.content else {
            Issue.record("expected device status")
            return
        }
        #expect(
            status.storage
                == StorageState(oldestPage: 100, newestPage: 2500, session: 3, freePages: 120_000, totalPages: 170_000))
        #expect(status.storage?.backlogPages == 2401)
        #expect(status.recording == nil, "no field 7 means unknown, not 'not recording'")
    }

    @Test func batteryStatusWithoutAStateIsStateZero() throws {
        // proto3 omits zero, so an empty `battery_status` carries state 0, not "no reading".
        var writer = ProtoWriter()
        writer.message(9) { _ in }
        #expect(try DeviceStatus(ProtoMessage(writer.data)).battery?.chargeState == 0)
    }
}

@Suite struct Reassembly {
    @Test func deviceInfoIdentifiesThePendantAndItsFlashLife() throws {
        var message = ProtoWriter()
        message.message(1) { info in
            info.varint(1, 77)
            info.bytes(2, Data("LP-123".utf8))
            info.varint(5, 9)
            info.varint(6, 3)
            info.varint(16, 2)
        }
        let decoded = try PendantMessage(decoding: message.data)
        let info = DeviceInfo(deviceID: 77, serial: "LP-123", storageInstance: 9, factoryResetID: 2)
        #expect(decoded.content == .deviceInfo(info))
        #expect(info.flashLifeEvidence == "serial LP-123, storage_instance 9, factory_reset_id 2")
        #expect(DeviceInfo().flashLifeEvidence == nil, "no identity, no evidence")
    }

    @Test func outOfOrderFragmentsJoinInSequenceOrder() throws {
        let payload = Data((0..<1000).map { UInt8(truncatingIfNeeded: $0) })
        let fragments = Fragment.split(payload, index: 4, maxFragmentSize: 200)
        #expect(fragments.count > 3)
        #expect(fragments.allSatisfy { $0.encoded.count <= 200 })
        var reassembler = Reassembler()
        var result: Data?
        for fragment in fragments.reversed() { result = try reassembler.accept(fragment) }
        #expect(result == payload)
        #expect(reassembler.openMessageCount == 0)
    }

    @Test func missingFragmentNeverCompletes() throws {
        let fragments = Fragment.split(Data(repeating: 7, count: 500), index: 1, maxFragmentSize: 100)
        var reassembler = Reassembler()
        for fragment in fragments.dropFirst() { #expect(try reassembler.accept(fragment) == nil) }
        #expect(reassembler.openMessageCount == 1)
    }

    @Test func identicalDuplicateIsIgnoredConflictingOneRejected() throws {
        var reassembler = Reassembler()
        let first = Fragment(index: 3, sequence: 0, count: 2, payload: Data([1]))
        #expect(try reassembler.accept(first) == nil)
        #expect(try reassembler.accept(first) == nil)
        #expect(throws: ProtocolError.conflictingDuplicateFragment(index: 3, sequence: 0)) {
            try reassembler.accept(Fragment(index: 3, sequence: 0, count: 2, payload: Data([2])))
        }
        #expect(reassembler.openMessageCount == 0)
    }

    @Test func countChangeAndBadSequenceAreRejected() throws {
        var reassembler = Reassembler()
        _ = try reassembler.accept(Fragment(index: 1, sequence: 0, count: 3, payload: Data([1])))
        #expect(throws: ProtocolError.fragmentCountChanged(index: 1)) {
            try reassembler.accept(Fragment(index: 1, sequence: 1, count: 4, payload: Data([2])))
        }
        let bad = Fragment(index: 1, sequence: 5, count: 2, payload: Data()).encoded
        #expect(throws: ProtocolError.fragmentSequenceOutOfRange(sequence: 5, count: 2)) {
            try Fragment(decoding: bad)
        }
        #expect(throws: ProtocolError.fragmentCountZero) { try Fragment(decoding: Data([0x08, 0x01])) }
    }

    @Test func omittedIndexAndSequenceReadAsZero() throws {
        let fragment = try Fragment(decoding: Data([0x18, 0x01, 0x22, 0x01, 0xaa]))
        #expect(fragment == Fragment(index: 0, sequence: 0, count: 1, payload: Data([0xaa])))
    }

    @Test func openPartialsAreBounded() throws {
        var reassembler = Reassembler(maxOpenMessages: 2)
        for index in UInt64(0)..<5 {
            _ = try reassembler.accept(Fragment(index: index, sequence: 0, count: 2, payload: Data([1])))
        }
        #expect(reassembler.openMessageCount == 2)
    }
}

@Suite struct AudioExtraction {
    private func page(chunks: [Data]) throws -> FlashPage {
        var writer = ProtoWriter()
        writer.varint(1, 1_750_000_000_000)
        for chunk in chunks { writer.bytes(3, chunk) }
        return try FlashPage(decoding: writer.data)
    }

    private func audioChunk(_ build: (inout ProtoWriter) -> Void) -> Data {
        var chunk = ProtoWriter()
        chunk.varint(1, 0)
        chunk.message(2, build)
        return chunk.data
    }

    @Test func keepsShortDTXPacketsFromField4() throws {
        let dtx = Data([0xb8])
        let full = Data([0xb8] + Array(repeating: 0x11, count: 60))
        let flash = try page(chunks: [
            audioChunk { $0.bytes(4, dtx) }, audioChunk { $0.bytes(4, full) },
            audioChunk { $0.bytes(1, Data(repeating: 0xb8, count: 40)) },
        ])
        #expect(flash.opusPackets == [dtx, full])
    }

    @Test func fallsBackToManualBeamformingField5() throws {
        let packet = Data([0x78, 0x01, 0x02])
        #expect(try page(chunks: [audioChunk { $0.bytes(5, packet) }]).opusPackets == [packet])
    }

    @Test func lifecycleOnlyChunkIsValidAndFrameless() throws {
        let flash = try page(chunks: [Data(hex: "12024801")])
        #expect(flash.opusPackets.isEmpty)
        #expect(flash.chunks.first?.audio?.didStopRecording == true)
    }

    @Test func encryptedAudioIsFlagged() throws {
        let flash = try page(chunks: [audioChunk { $0.message(13) { $0.bytes(2, Data([1, 2, 3])) } }])
        #expect(flash.isEncrypted)
    }
}

@Suite struct InboundMessages {
    @Test func flashPageErrorKeepsConflictingMappingExplicit() throws {
        for (raw, expected) in [(UInt64(1), FlashPageError.readFailed), (2, .corrupt), (9, .unknown(9))] {
            var writer = ProtoWriter()
            writer.varint(5, 77)
            writer.varint(7, raw)
            let buffer = try StorageBuffer(decoding: writer.data)
            #expect(buffer.error == expected)
            #expect(buffer.error?.rawValue == raw)
            #expect(buffer.flashPage == nil)
        }
    }

    @Test func responseErrorAndRecordingStatus() throws {
        var writer = ProtoWriter()
        writer.message(5) { status in status.message(7) { _ in } }
        writer.message(6) { response in
            response.varint(1, 12)
            response.message(2) { error in
                error.varint(1, 1)
                error.bytes(2, Data("busy".utf8))
            }
        }
        let message = try PendantMessage(decoding: writer.data)
        #expect(message.response == CommandResponse(requestID: 12, failure: .failedToExecute(message: "busy")))
        #expect(message.content == .deviceStatus(DeviceStatus(recording: RecordingStatus(state: .notRecording))))
    }

    @Test func recordingStatusKeepsTheDetectorLevelOnlyWhenSent() throws {
        var writer = ProtoWriter()
        writer.message(5) { status in
            status.message(7) { recording in
                recording.varint(1, 1)
                recording.varint(2, 1)
                recording.varint(3, 42)
            }
        }
        let message = try PendantMessage(decoding: writer.data)
        #expect(
            message.content
                == .deviceStatus(DeviceStatus(recording: RecordingStatus(state: .recording, source: 1, vadLevel: 42))))
        let bare = try RecordingStatus(ProtoMessage(Data([0x08, 0x01])))
        #expect(bare.vadLevel == nil, "absent is unknown, not 0")
    }

    @Test func liveButtonEvent() throws {
        var writer = ProtoWriter()
        writer.message(8) { button in
            button.varint(1, 2)
            button.varint(6, 1_750_000_000_000)
        }
        let message = try PendantMessage(decoding: writer.data)
        #expect(message.content == .button(ButtonStatus(event: .long, eventTimestampMillis: 1_750_000_000_000)))
    }

    @Test func garbageNeverTraps() {
        var seed: UInt64 = 0x9e37_79b9_7f4a_7c15
        for length in 0..<2000 {
            let bytes = (0..<(length % 64)).map { _ in
                seed = seed &* 6_364_136_223_846_793_005 &+ 1_442_695_040_888_963_407
                return UInt8(truncatingIfNeeded: seed >> 33)
            }
            let data = Data(bytes)
            _ = try? Fragment(decoding: data)
            _ = try? PendantMessage(decoding: data)
            _ = try? FlashPage(decoding: data)
            _ = try? PendantCommand.decode(data)
        }
        #expect(throws: ProtocolError.varintTooLong) { try ProtoMessage(Data(repeating: 0xff, count: 11)) }
    }
}
