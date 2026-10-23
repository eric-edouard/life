package com.ericedouard.lifelog

import android.content.Context
import androidx.core.content.edit
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.update

/**
 * What the phone keeps besides the outbox, in app-private preferences (the app opts out of backup): the pairing, the
 * paired Omi, the flash life and the last record stored. `status` is what the screen shows, kept current by the service.
 */
class Store(context: Context) {
    private val prefs = context.getSharedPreferences("lifelog", Context.MODE_PRIVATE)

    var pairing: Pairing?
        get() = prefs.getString("server", null)?.let { Pairing(it, prefs.getString("token", null)!!) }
        set(value) = prefs.edit(commit = true) {
            putString("server", value?.server)
            putString("token", value?.token)
        }.also { status.update { it.copy(server = value?.host) } }

    /** The Omi's Bluetooth address, set by the first drain: later drains connect to it only. */
    var recorder: String?
        get() = prefs.getString("recorder", null)
        set(value) = prefs.edit(commit = true) { putString("recorder", value) }

    /** The ring number of the newest record stored in this flash life; -1 before the first. */
    var lastSeq: Long
        get() = prefs.getLong("lastSeq", -1)
        set(value) = prefs.edit(commit = true) { putLong("lastSeq", value) }

    val lifeBase: Long get() = Band.base(prefs.getLong("life", 0))

    /** A cleared ring restarts its numbers at 0: its records go into the next band, so no index is reused. */
    fun newLife() = prefs.edit(commit = true) {
        putLong("life", prefs.getLong("life", 0) + 1)
        putLong("lastSeq", -1)
    }

    /** Moves to the next band and returns its base. The ring's numbering goes on: a cleared ring found only by a page
     * conflict (`Uploader`) keeps its records' numbers in the new band. */
    fun nextBand(): Long {
        prefs.edit(commit = true) { putLong("life", prefs.getLong("life", 0) + 1) }
        return lifeBase
    }

    var lastUpload: Long
        get() = prefs.getLong("lastUpload", 0)
        set(value) = prefs.edit(commit = true) { putLong("lastUpload", value) }

    val status = MutableStateFlow(Status(server = pairing?.host, lastUpload = lastUpload.takeIf { it > 0 }))

    companion object {
        @Volatile private var shared: Store? = null

        fun of(context: Context) = shared ?: synchronized(this) {
            shared ?: Store(context.applicationContext).also { shared = it }
        }
    }
}

/** The status screen: paired or not, the recorder, the last upload, the queue. */
data class Status(
    val server: String? = null,
    val syncing: Boolean = false,
    val recorder: String = "Not seen yet",
    val recorderConnected: Boolean = false,
    val lastUpload: Long? = null,
    val uploadError: String? = null,
    val queued: Long = 0,
)

/** Page indices are a band, the flash life, times 2^40 plus the ring number, as on the iPhone (`SourceStore`). */
object Band {
    private const val BITS = 40

    fun base(life: Long) = life shl BITS

    fun of(page: Long) = page shr BITS

    fun seq(page: Long) = page and (1L shl BITS) - 1
}
