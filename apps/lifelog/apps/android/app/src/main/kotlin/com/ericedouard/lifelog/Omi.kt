package com.ericedouard.lifelog

import java.util.UUID

// The Omi pendant's offline ring (firmware 3.0.20 and later), ported from the iPhone's
// `apps/ios/Kit/Sources/PendantProtocol/Omi.swift`. See `docs/research/omi.md`. Codec only: no I/O.

object OmiGatt {
    /** Advertised: how a scan finds an Omi. Its live audio is never subscribed to: while subscribed it streams instead of writing its ring. */
    val audioService: UUID = UUID.fromString("19B10000-E8F2-537E-4F6C-D104768A1214")
    val storageService: UUID = UUID.fromString("30295780-4301-EABD-2904-2849ADFEAE43")

    /** Ring commands are written here, and every ring notification comes on it. */
    val storageControl: UUID = UUID.fromString("30295781-4301-EABD-2904-2849ADFEAE43")
    val timeService: UUID = UUID.fromString("19B10030-E8F2-537E-4F6C-D104768A1214")

    /** Epoch seconds, a little-endian UInt32. The ring writes nothing until the clock is set. */
    val timeWrite: UUID = UUID.fromString("19B10031-E8F2-537E-4F6C-D104768A1214")
    val clientConfig: UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")
}

/** Ring commands, written with response to `OmiGatt.storageControl`. CLEAR (0x13) is deliberately not representable. */
sealed interface OmiCommand {
    val bytes: ByteArray

    data object Info : OmiCommand {
        override val bytes = byteArrayOf(0x10)
    }

    /** Streams every record from `seq` to the write number. */
    data class Read(val from: Long) : OmiCommand {
        override val bytes get() = byteArrayOf(0x11) + bigEndian(from)
    }

    /** Frees every record below `seq`. Destructive. */
    data class Advance(val to: Long) : OmiCommand {
        override val bytes get() = byteArrayOf(0x12) + bigEndian(to)
    }

    companion object {
        /** The clock write: epoch seconds, little-endian, to `OmiGatt.timeWrite`. */
        fun clock(unixMillis: Long): ByteArray {
            val seconds = (unixMillis / 1000).coerceIn(0, 0xFFFF_FFFFL)
            return ByteArray(4) { (seconds shr (8 * it)).toByte() }
        }
    }
}

/** The ring's numbers: records `read until write` are held, the oldest first. */
data class OmiRingInfo(val read: Long, val write: Long, val capacity: Long, val dropped: Long)

/** One notification on `OmiGatt.storageControl`: an opcode byte, then its payload, numbers big-endian. */
sealed interface OmiNotification {
    data class Ack(val status: Int) : OmiNotification

    data class Info(val info: OmiRingInfo) : OmiNotification

    /** Record bytes, not aligned to records. */
    class Data(val bytes: ByteArray) : OmiNotification

    data class Done(val status: Int, val next: Long) : OmiNotification

    /** A read begins at `start`: the next data byte is that record's first. */
    data class ReadBegin(val start: Long, val count: Long) : OmiNotification

    companion object {
        fun decode(bytes: ByteArray): OmiNotification {
            val op = bytes.firstOrNull()?.toInt() ?: throw ProtocolException("empty notification")
            fun need(size: Int) {
                if (bytes.size < size) throw ProtocolException("truncated opcode $op")
            }
            return when (op) {
                0x01 -> {
                    need(2)
                    Ack(bytes[1].toInt() and 0xFF)
                }
                0x02 -> {
                    need(31)
                    Info(OmiRingInfo(uint(bytes, 1, 8), uint(bytes, 9, 8), uint(bytes, 17, 4), uint(bytes, 21, 8)))
                }
                0x03 -> Data(bytes.copyOfRange(1, bytes.size))
                0x04 -> {
                    need(10)
                    Done(bytes[1].toInt() and 0xFF, uint(bytes, 2, 8))
                }
                0x05 -> {
                    need(13)
                    ReadBegin(uint(bytes, 1, 8), uint(bytes, 9, 4))
                }
                else -> throw ProtocolException("unknown opcode $op")
            }
        }
    }
}

/** One ring record: a 4-byte big-endian UTC second, then 440 bytes of Opus frames. The phone stores it unread; the
 * server places and decodes it. */
object OmiRecord {
    const val SIZE = 444
}

/** Rebuilds whole records from data notifications that split them anywhere. One per read: `begin` at its start. */
class OmiRecordStream {
    private var buffer = ByteArray(0)

    /** The ring number of the record the buffer starts with; null before a read began. */
    private var next: Long? = null

    fun begin(start: Long) {
        buffer = ByteArray(0)
        next = start
    }

    /** The records `bytes` completes, each with its ring number. Bytes before a read began are dropped. */
    fun append(bytes: ByteArray): List<Pair<Long, ByteArray>> {
        var seq = next ?: return emptyList()
        buffer += bytes
        val records = mutableListOf<Pair<Long, ByteArray>>()
        var offset = 0
        while (buffer.size - offset >= OmiRecord.SIZE) {
            records += seq to buffer.copyOfRange(offset, offset + OmiRecord.SIZE)
            offset += OmiRecord.SIZE
            seq += 1
        }
        buffer = buffer.copyOfRange(offset, buffer.size)
        next = seq
        return records
    }
}

class ProtocolException(message: String) : Exception(message)

internal fun bigEndian(value: Long) = ByteArray(8) { (value shr (56 - 8 * it)).toByte() }

/** An unsigned big-endian number of `size` bytes at `offset`. */
internal fun uint(bytes: ByteArray, offset: Int, size: Int): Long =
    (offset until offset + size).fold(0L) { acc, i -> acc shl 8 or (bytes[i].toLong() and 0xFF) }
