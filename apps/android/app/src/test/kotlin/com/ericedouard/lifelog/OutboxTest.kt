package com.ericedouard.lifelog

import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class OutboxTest {
    @get:Rule val folder = TemporaryFolder()

    private fun page(index: Long) = index to record(index.toInt())

    @Test fun eachDrainIsItsOwnFileInOrder() {
        val outbox = Outbox(folder.root)
        outbox.drain().apply {
            append((0L..2).map(::page))
            append(listOf(page(3)))
        }
        Thread.sleep(2)
        outbox.drain().append(listOf(page(9)))
        val files = outbox.files()
        assertEquals(listOf(listOf(0L, 1L, 2L, 3L), listOf(9L)), files.map { f -> Outbox.records(f).map { it.first }.toList() })
        assertEquals(5L, outbox.count)
    }

    @Test fun aTornTailEndsItsFile() {
        val outbox = Outbox(folder.root)
        outbox.drain().append(listOf(page(0)))
        val file = outbox.files().single()
        file.appendBytes(ByteArray(100))
        assertEquals(listOf(0L), Outbox.records(file).map { it.first }.toList())
    }

    @Test fun aClearedRingMovesTheConflictAndEverythingAfterItInItsBand() {
        val band = Band.base(1)
        val outbox = Outbox(folder.root)
        outbox.drain().append(listOf(page(3), page(4), page(5), page(band + 2)))
        outbox.renumber { Uploader.rebanded(it, conflict = 4, base = 2 * band) }
        assertEquals(
            listOf(3L, 2 * band + 4, 2 * band + 5, band + 2),
            Outbox.records(outbox.files().single()).map { it.first }.toList(),
        )
    }

    @Test fun batchesStopAtGapsAndFiveHundredPages() {
        val pages = (0L until 600).map { it to ByteArray(0) } + (700L to ByteArray(0))
        assertEquals(listOf(500, 100, 1), Uploader.batches(pages.asSequence()).map { it.size }.toList())
    }
}
