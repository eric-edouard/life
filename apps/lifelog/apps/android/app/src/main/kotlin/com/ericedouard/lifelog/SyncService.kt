package com.ericedouard.lifelog

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.PowerManager
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/**
 * The `connectedDevice` foreground service that keeps the Omi drained: every `CYCLE_MILLIS`, one drain, then the
 * outbox goes up. A partial wakelock is held only while a cycle runs; between cycles the phone may sleep, and Doze may
 * stretch the wait, which only delays the next drain: the Omi keeps recording into its ring meanwhile.
 */
class SyncService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var running: Job? = null

    override fun onBind(intent: Intent?) = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startForeground(1, notification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE)
        if (running == null) running = scope.launch { loop() }
        return START_STICKY
    }

    override fun onDestroy() {
        scope.cancel()
        Store.of(this).status.update { it.copy(syncing = false, recorderConnected = false) }
    }

    private suspend fun loop() {
        val store = Store.of(this)
        val outbox = Outbox(filesDir)
        // Not reference-counted: a cycle past the timeout releases nothing instead of throwing.
        val lock = getSystemService(PowerManager::class.java)
            .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "lifelog:drain").apply { setReferenceCounted(false) }
        store.status.update { it.copy(syncing = true, queued = outbox.count) }
        while (scope.isActive) {
            // A service stopped and started again may still be finishing its last cycle: they never overlap.
            cycleLock.withLock {
                lock.acquire(CYCLE_TIMEOUT_MILLIS)
                try {
                    cycle(store, outbox)
                } finally {
                    lock.release()
                }
            }
            delay(CYCLE_MILLIS)
        }
    }

    private suspend fun cycle(store: Store, outbox: Outbox) {
        val recorder = attempt {
            OmiDrain(this, store, outbox).run {
                store.status.update { it.copy(recorder = "Draining", recorderConnected = true) }
            }
        }.fold({ "Drained $it records" }, { if (it is TimeoutCancellationException) "Timed out" else "Lost: ${it.message}" })
        store.status.update { it.copy(recorder = recorder, recorderConnected = false, queued = outbox.count) }
        val pairing = store.pairing ?: return
        val error = attempt { Uploader(pairing, outbox, cacheDir, store::nextBand).upload() }.exceptionOrNull()
        if (error == null) store.lastUpload = System.currentTimeMillis()
        store.status.update {
            it.copy(lastUpload = store.lastUpload.takeIf { t -> t > 0 }, uploadError = error?.message, queued = outbox.count)
        }
    }

    private fun notification(): Notification {
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(NotificationChannel("sync", "Sync", NotificationManager.IMPORTANCE_LOW))
        val open = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE,
        )
        return Notification.Builder(this, "sync")
            .setSmallIcon(R.drawable.ic_mark)
            .setContentTitle("lifelog")
            .setContentText("Keeping the Omi drained")
            .setContentIntent(open)
            .setOngoing(true)
            .build()
    }

    private companion object {
        val cycleLock = Mutex()
        const val CYCLE_MILLIS = 5 * 60_000L
        const val CYCLE_TIMEOUT_MILLIS = 10 * 60_000L
    }
}

/**
 * A failed step, for the screen. A timeout inside it (itself a `CancellationException`) is a failure; the caller being
 * stopped is not: it stops.
 */
internal suspend inline fun <T> attempt(block: () -> T): Result<T> =
    runCatching(block).onFailure { if (it is CancellationException) currentCoroutineContext().ensureActive() }
