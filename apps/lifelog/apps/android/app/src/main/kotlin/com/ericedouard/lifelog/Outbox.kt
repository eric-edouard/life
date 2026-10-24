package com.ericedouard.lifelog

import java.io.DataInputStream
import java.io.EOFException
import java.io.File
import java.io.FileOutputStream
import java.nio.channels.FileChannel
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.nio.file.StandardOpenOption

/**
 * The records drained from the Omi and not yet with the server: one file per drain, `outbox/<started ms>.bin`, of
 * `[page u64][record]` entries in page order. A record is durable once `append` returns (fsync'd), and only then is it
 * advanced on the Omi. A file goes once the server holds its last page; a crash before that sends it again, which the
 * server accepts. A torn tail (a crash mid-append) ends its file's reading; the next drain writes a new file.
 */
class Outbox(dir: File) {
    private val dir = File(dir, "outbox").apply { mkdirs() }

    val count: Long get() = files().sumOf { it.length() / ENTRY }

    /** Drained files, oldest first. */
    fun files(): List<File> = dir.listFiles { f -> f.extension == "bin" }.orEmpty().sortedBy { it.nameWithoutExtension.toLong() }

    /** Gives every stored record the page `move` maps it to, rewriting only the files that change, each atomically. */
    fun renumber(move: (Long) -> Long) {
        for (file in files()) {
            val records = records(file).toList()
            if (records.none { (page, _) -> move(page) != page }) continue
            val next = File(dir, "${file.nameWithoutExtension}.next").apply { delete() }
            write(next, records.map { (page, record) -> move(page) to record })
            // Throws rather than leave the old numbers in place (a conflict found again would take band after band).
            Files.move(next.toPath(), file.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
        }
    }

    /** A new drain's file, created with its first record. */
    fun drain() = Drain()

    inner class Drain {
        private var file: File? = null

        fun append(records: List<Pair<Long, ByteArray>>) {
            if (records.isEmpty()) return
            val target = file ?: File(dir, "${System.currentTimeMillis()}.bin").also {
                it.createNewFile()
                // The new file's entry is durable too before anything in it is advanced on the Omi.
                FileChannel.open(dir.toPath(), StandardOpenOption.READ).use { d -> d.force(true) }
                file = it
            }
            write(target, records)
        }
    }

    private fun write(target: File, records: List<Pair<Long, ByteArray>>) =
        FileOutputStream(target, true).use { out ->
            val buffered = out.buffered()
            for ((page, record) in records) buffered.write(bigEndian(page) + record)
            buffered.flush()
            out.fd.sync()
        }

    companion object {
        private const val ENTRY = 8 + OmiRecord.SIZE

        /** A drained file's records, in order. */
        fun records(file: File) = sequence {
            DataInputStream(file.inputStream().buffered()).use { input ->
                while (true) {
                    val page = try {
                        input.readLong()
                    } catch (_: EOFException) {
                        break
                    }
                    val record = ByteArray(OmiRecord.SIZE)
                    try {
                        input.readFully(record)
                    } catch (_: EOFException) {
                        break
                    }
                    yield(page to record)
                }
            }
        }
    }
}
