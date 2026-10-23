package com.ericedouard.lifelog

import android.annotation.SuppressLint
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.le.BluetoothLeScanner
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanFilter
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.Context
import android.os.ParcelUuid
import kotlinx.coroutines.CancellableContinuation
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeout
import kotlin.coroutines.resume

/**
 * One drain of an Omi's ring, as the iPhone's `OmiCodec` does it (`docs/research/omi.md`, "What the app does"): find
 * it, connect, set its clock, INFO, READ from the oldest record the phone doesn't hold, store each record fsync'd in
 * the outbox, ADVANCE past what is stored, and let go: an Omi drops its audio while a phone is connected without
 * streaming it live, so the phone connects only to drain.
 *
 * Firmware 3.0.21 frees a record as soon as Bluetooth delivered it (the owner accepted the risk, `docs/research/omi.md`,
 * "Custody risk"): the records are stored as they arrive, at most `FLUSH_MILLIS` after, and kept when the link drops.
 * Pages are `Store.lifeBase + seq`; a write number at or below what the phone holds is a cleared ring, a new life.
 */
@SuppressLint("MissingPermission") // The service runs only once BLUETOOTH_SCAN and BLUETOOTH_CONNECT are granted.
class OmiDrain(private val context: Context, private val store: Store, private val outbox: Outbox) {
    private val events = Channel<Event>(Channel.UNLIMITED)

    /** Drains once; returns the records stored. */
    suspend fun run(onConnected: () -> Unit): Int {
        val device = withTimeout(SCAN_MILLIS) { find(store.recorder) }
        store.recorder = device.address
        val gatt = device.connectGatt(context, false, callback, BluetoothDevice.TRANSPORT_LE)
        val file = outbox.drain()
        var progress: DrainedRun? = null
        try {
            await<Event.Connected>()
            onConnected()
            gatt.requestMtu(517)
            await<Event.Mtu>()
            gatt.discoverServices()
            await<Event.Discovered>()
            val clock = gatt.getService(OmiGatt.timeService).getCharacteristic(OmiGatt.timeWrite)
            write(gatt, clock, OmiCommand.clock(System.currentTimeMillis()))
            val control = gatt.getService(OmiGatt.storageService).getCharacteristic(OmiGatt.storageControl)
            gatt.setCharacteristicNotification(control, true)
            gatt.writeDescriptor(
                control.getDescriptor(OmiGatt.clientConfig), BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE,
            )
            written()
            write(gatt, control, OmiCommand.Info.bytes)
            var info: OmiRingInfo? = null
            while (info == null) info = (next() as? OmiNotification.Info)?.info
            if (info.write <= store.lastSeq) store.newLife()
            // From the ring's oldest record, never past it: records skipped would be freed by the ADVANCE unread. One
            // the phone holds already comes again with the same bytes, which the server accepts.
            if (info.read >= info.write) return 0
            val read = DrainedRun(info.read) { records ->
                file.append(records.map { (seq, record) -> store.lifeBase + seq to record })
                store.lastSeq = maxOf(store.lastSeq, records.maxOf { it.first })
            }
            progress = read
            var flushed = System.currentTimeMillis()
            write(gatt, control, OmiCommand.Read(info.read).bytes)
            val stream = OmiRecordStream()
            reading@ while (true) {
                when (val notification = next()) {
                    is OmiNotification.ReadBegin -> stream.begin(notification.start)
                    is OmiNotification.Data -> read.add(stream.append(notification.bytes))
                    is OmiNotification.Done -> break@reading
                    is OmiNotification.Ack -> if (notification.status != 0) error("READ refused: ${notification.status}")
                    is OmiNotification.Info -> {}
                }
                if (System.currentTimeMillis() - flushed >= FLUSH_MILLIS) {
                    read.flush()
                    flushed = System.currentTimeMillis()
                }
            }
            read.flush()
            read.advanceTo?.let { write(gatt, control, OmiCommand.Advance(it).bytes) }
            return read.stored
        } finally {
            // A link left open would keep the Omi from recording: closed even when the last flush fails.
            try {
                progress?.flush()
            } finally {
                gatt.disconnect()
                gatt.close()
            }
        }
    }

    /** The paired Omi by its address, or the first Omi in range before one is paired. */
    private suspend fun find(address: String?): BluetoothDevice {
        val scanner = context.getSystemService(BluetoothManager::class.java).adapter.bluetoothLeScanner
            ?: error("Bluetooth is off")
        return suspendCancellableCoroutine { continuation -> scan(scanner, address, continuation) }
    }

    private fun scan(
        scanner: BluetoothLeScanner,
        address: String?,
        continuation: CancellableContinuation<BluetoothDevice>,
    ) {
        val callback = object : ScanCallback() {
            override fun onScanResult(type: Int, result: ScanResult) {
                scanner.stopScan(this)
                if (continuation.isActive) continuation.resume(result.device)
            }
        }
        scanner.startScan(
            listOf(
                ScanFilter.Builder().setServiceUuid(ParcelUuid(OmiGatt.audioService))
                    .apply { address?.let(::setDeviceAddress) }.build(),
            ),
            ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build(),
            callback,
        )
        continuation.invokeOnCancellation { scanner.stopScan(callback) }
    }

    private suspend fun write(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic, bytes: ByteArray) {
        gatt.writeCharacteristic(characteristic, bytes, BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT)
        written()
    }

    private suspend fun written() {
        val status = await<Event.Written>().status
        if (status != BluetoothGatt.GATT_SUCCESS) error("a write failed: $status")
    }

    /** The next ring notification; throws once the Omi stays silent for `IDLE_MILLIS`. */
    private suspend fun next() = OmiNotification.decode(await<Event.Notified>().bytes)

    private suspend inline fun <reified T : Event> await(): T = withTimeout(IDLE_MILLIS) {
        var event = events.receive()
        while (event !is T) {
            if (event is Event.Lost) error("the Omi disconnected")
            event = events.receive()
        }
        event
    }

    private sealed interface Event {
        data object Connected : Event

        data object Lost : Event

        data object Mtu : Event

        data object Discovered : Event

        class Written(val status: Int) : Event

        class Notified(val bytes: ByteArray) : Event
    }

    private val callback = object : BluetoothGattCallback() {
        override fun onConnectionStateChange(gatt: BluetoothGatt, status: Int, state: Int) {
            events.trySend(if (state == BluetoothProfile.STATE_CONNECTED) Event.Connected else Event.Lost)
        }

        override fun onMtuChanged(gatt: BluetoothGatt, mtu: Int, status: Int) {
            events.trySend(Event.Mtu)
        }

        override fun onServicesDiscovered(gatt: BluetoothGatt, status: Int) {
            events.trySend(Event.Discovered)
        }

        override fun onCharacteristicWrite(gatt: BluetoothGatt, c: BluetoothGattCharacteristic, status: Int) {
            events.trySend(Event.Written(status))
        }

        override fun onDescriptorWrite(gatt: BluetoothGatt, d: BluetoothGattDescriptor, status: Int) {
            events.trySend(Event.Written(status))
        }

        override fun onCharacteristicChanged(gatt: BluetoothGatt, c: BluetoothGattCharacteristic, value: ByteArray) {
            events.trySend(Event.Notified(value))
        }
    }

    private companion object {
        const val SCAN_MILLIS = 30_000L
        const val IDLE_MILLIS = 15_000L
        const val FLUSH_MILLIS = 1_000L
    }
}
