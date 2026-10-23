package com.ericedouard.lifelog

import android.Manifest
import android.content.Intent
import android.os.Bundle
import android.text.format.DateUtils
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning

/** The one screen: paired or not, the recorder, the last upload, the queue; pairing and the sync switch. */
class MainActivity : ComponentActivity() {
    /** A pairing link waiting for the owner's yes: a link never repoints the app alone. */
    private val offered = mutableStateOf<Pairing?>(null)

    private val permissions = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
        // Notifications are optional: the service runs without its notification showing.
        if (it[Manifest.permission.BLUETOOTH_SCAN] == true && it[Manifest.permission.BLUETOOTH_CONNECT] == true) {
            startForegroundService(Intent(this, SyncService::class.java))
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        offer(intent)
        val store = Store.of(this)
        setContent {
            val status by store.status.collectAsStateWithLifecycle()
            Screen(
                status, offered.value,
                scan = ::scan,
                confirm = { pairing ->
                    store.pairing = pairing
                    offered.value = null
                },
                dismiss = { offered.value = null },
                sync = { on ->
                    if (on) {
                        permissions.launch(
                            arrayOf(
                                Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_CONNECT,
                                Manifest.permission.POST_NOTIFICATIONS,
                            ),
                        )
                    } else {
                        stopService(Intent(this, SyncService::class.java))
                    }
                },
            )
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        offer(intent)
    }

    private fun offer(intent: Intent) {
        intent.dataString?.let(Pairing::parse)?.let { offered.value = it }
    }

    private fun scan() {
        val options = GmsBarcodeScannerOptions.Builder().setBarcodeFormats(Barcode.FORMAT_QR_CODE).build()
        GmsBarcodeScanning.getClient(this, options).startScan()
            .addOnSuccessListener { code -> code.rawValue?.let(Pairing::parse)?.let { offered.value = it } }
    }
}

@Composable
private fun Screen(
    status: Status,
    offered: Pairing?,
    scan: () -> Unit,
    confirm: (Pairing) -> Unit,
    dismiss: () -> Unit,
    sync: (Boolean) -> Unit,
) {
    val brand = Brand.current
    Column(
        Modifier.fillMaxSize().background(brand.page).safeDrawingPadding().padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        BasicText("lifelog", style = TextStyle(fontFamily = Brand.serif, fontWeight = FontWeight.SemiBold, fontSize = 36.sp, color = brand.ink))
        Column(
            Modifier.fillMaxWidth().background(brand.surface, RoundedCornerShape(Brand.panel)).padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Line("Server", if (status.server != null) Brand.synced else Brand.unknown, status.server ?: "Not paired")
            Line(
                "Recorder",
                when {
                    status.recorderConnected -> Brand.synced
                    status.syncing -> Brand.open
                    else -> Brand.unknown
                },
                if (status.syncing) status.recorder else "Sync off",
            )
            Line(
                "Last upload",
                if (status.uploadError != null) Brand.error else if (status.lastUpload != null) Brand.synced else Brand.unknown,
                status.uploadError
                    ?: status.lastUpload?.let { DateUtils.getRelativeTimeSpanString(it).toString() }
                    ?: "None yet",
            )
            Line("Queue", if (status.queued > 0) Brand.open else Brand.synced, "${status.queued} records")
        }
        Spacer(Modifier.weight(1f))
        if (offered != null) {
            BasicText(
                "Send this phone's recordings to ${offered.host}?",
                style = TextStyle(fontFamily = Brand.serif, fontSize = 16.sp, color = brand.ink),
            )
            Button("Pair", primary = true) { confirm(offered) }
            Button("Cancel", primary = false, onClick = dismiss)
        } else {
            Button(if (status.server == null) "Scan the pairing code" else "Pair again", primary = status.server == null, onClick = scan)
            Button(if (status.syncing) "Stop syncing" else "Start syncing", primary = status.server != null && !status.syncing) {
                sync(!status.syncing)
            }
        }
    }
}

/** A label, then a status dot paired with its word. */
@Composable
private fun Line(label: String, tone: Color, value: String) {
    val brand = Brand.current
    Row(verticalAlignment = Alignment.CenterVertically) {
        BasicText(label, style = TextStyle(fontFamily = Brand.serif, fontSize = 16.sp, color = brand.muted))
        // Right-aligned; a long value wraps beside its dot and the label keeps its width.
        Row(
            Modifier.weight(1f).padding(start = 16.dp),
            horizontalArrangement = Arrangement.End,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(Modifier.size(8.dp).background(tone, CircleShape))
            BasicText(
                value, Modifier.padding(start = 8.dp).weight(1f, fill = false),
                style = TextStyle(fontFamily = Brand.mono, fontWeight = FontWeight.Medium, fontSize = 13.sp, color = brand.ink),
            )
        }
    }
}

/** One primary action is ink; everything else stays light. */
@Composable
private fun Button(text: String, primary: Boolean, onClick: () -> Unit) {
    val brand = Brand.current
    val shape = RoundedCornerShape(Brand.control)
    Box(
        Modifier.fillMaxWidth()
            .background(if (primary) brand.ink else brand.page, shape)
            .border(1.dp, if (primary) brand.ink else brand.rule, shape)
            .clickable(onClick = onClick)
            .padding(14.dp),
        contentAlignment = Alignment.Center,
    ) {
        BasicText(
            text,
            style = TextStyle(
                fontFamily = Brand.serif, fontWeight = FontWeight.SemiBold, fontSize = 16.sp,
                color = if (primary) brand.page else brand.ink,
            ),
        )
    }
}
