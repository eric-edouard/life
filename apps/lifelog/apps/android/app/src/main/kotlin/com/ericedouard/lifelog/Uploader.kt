package com.ericedouard.lifelog

import com.ericedouard.lifelog.api.apis.DefaultApi
import com.ericedouard.lifelog.api.infrastructure.ApiClient
import com.ericedouard.lifelog.api.infrastructure.ClientError
import com.ericedouard.lifelog.api.infrastructure.ClientException
import com.ericedouard.lifelog.api.models.PageBatch
import com.ericedouard.lifelog.api.models.PageBatchPagesInner
import com.ericedouard.lifelog.api.models.PageConflict as ServerConflict
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.serialization.json.Json
import java.io.File
import java.security.MessageDigest

/**
 * Sends the outbox's records to the server as raw pages (`PUT /sources/{id}/pages/{firstPage}`), oldest drain first,
 * through the client generated from `apps/server/openapi.json`. The server decides what is speech and what gets
 * transcribed; a drain's file goes only once a 200 says the server holds its last batch.
 */
class Uploader(
    pairing: Pairing,
    private val outbox: Outbox,
    private val scratch: File,
    /** Moves the phone to a new band and returns its base (`Store.nextBand`). */
    private val nextBand: () -> Long,
) {
    private val api = DefaultApi(pairing.server.trimEnd('/')).also { ApiClient.accessToken = pairing.token }

    suspend fun upload() {
        // A conflict found again in each new band would mean a server answering wrongly: give up after a few.
        for (attempt in 0..MAX_REBANDS) {
            try {
                for (file in outbox.files()) {
                    for (batch in batches(Outbox.records(file))) {
                        currentCoroutineContext().ensureActive()
                        send(batch)
                    }
                    file.delete()
                }
                return
            } catch (e: PageConflict) {
                if (attempt == MAX_REBANDS) throw e
                // The ring was cleared and the drain didn't see it, or a reinstall forgot its band (the iPhone re-bands a
                // clash the same way, `docs/research/omi.md`, "Flash lives"). Nothing of the batch was kept; the pages
                // before the conflict go again as they are, accepted once, so nothing is stored or paid for twice.
                val band = nextBand()
                outbox.renumber { rebanded(it, e.page, band) }
            }
        }
    }

    private fun send(batch: List<Pair<Long, ByteArray>>) {
        val bytes = batch.fold(ByteArray(0)) { all, (_, record) -> all + record }
        val metadata = PageBatch(
            codec = PageBatch.Codec.omi,
            sha256 = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) },
            pages = batch.map { (page, record) -> PageBatchPagesInner(index = page, length = record.size.toLong()) },
        )
        val file = File(scratch, "pages").apply { writeBytes(bytes) }
        try {
            api.sourcesSourceIdPagesFirstPagePut(SOURCE, batch.first().first, Json.encodeToString(metadata), file)
        } catch (e: ClientException) {
            val body = (e.response as? ClientError<*>)?.body as? String
            if (e.statusCode == 409 && body != null) throw PageConflict(json.decodeFromString<ServerConflict>(body).page)
            throw e
        }
    }

    /** The server holds other bytes at `page`; nothing of its batch was kept. */
    private class PageConflict(val page: Long) : Exception("Page conflict at $page")

    companion object {
        /** Android's own source, never the iPhone's `omi-pendant`. */
        const val SOURCE = "android-omi"
        private const val MAX_PAGES = 500
        private const val MAX_REBANDS = 8

        private val json = Json { ignoreUnknownKeys = true }

        /** Where `page` goes once the ring was found cleared at `conflict`: it and every later page of its band move to
         * the band at `base`, keeping their ring numbers. */
        fun rebanded(page: Long, conflict: Long, base: Long): Long =
            if (page >= conflict && Band.of(page) == Band.of(conflict)) base + Band.seq(page) else page

        /** Runs of consecutive pages, at most `MAX_PAGES` each: a gap inside one batch is refused, between two it is a hole. */
        fun batches(records: Sequence<Pair<Long, ByteArray>>) = sequence {
            var open = mutableListOf<Pair<Long, ByteArray>>()
            for (record in records) {
                if (open.isNotEmpty() && (open.size == MAX_PAGES || open.last().first + 1 != record.first)) {
                    yield(open)
                    open = mutableListOf()
                }
                open += record
            }
            if (open.isNotEmpty()) yield(open)
        }
    }
}
