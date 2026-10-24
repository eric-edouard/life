package com.ericedouard.lifelog

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class OmiTest {
    /** The ring's bytes both phones read alike (`fixtures/wire/omi-ring.json`, shared with the iPhone). */
    @Test fun commandsAndNotificationsMatchTheSharedFixture() {
        val wire = Json.parseToJsonElement(File("../../../fixtures/wire/omi-ring.json").readText()).jsonObject
        for (c in wire.getValue("commands").jsonArray.map { it.jsonObject }) {
            val name = c.string("name")
            val bytes = when (name) {
                "info" -> OmiCommand.Info.bytes
                "read" -> OmiCommand.Read(c.long("seq")).bytes
                "advance" -> OmiCommand.Advance(c.long("seq")).bytes
                "clock" -> OmiCommand.clock(c.long("unixMillis"))
                else -> error("unknown command $name")
            }
            assertEquals(name, c.string("hex"), bytes.toHexString())
        }
        for (n in wire.getValue("notifications").jsonArray.map { it.jsonObject }) {
            val name = n.string("name")
            val bytes = n.string("hex").hexToByteArray()
            if ("error" in n) {
                assertThrows(name, ProtocolException::class.java) { OmiNotification.decode(bytes) }
                continue
            }
            val decoded = OmiNotification.decode(bytes)
            when (name) {
                "ack" -> assertEquals(name, OmiNotification.Ack(n.long("status").toInt()), decoded)
                "info" -> assertEquals(
                    name,
                    OmiNotification.Info(OmiRingInfo(n.long("read"), n.long("write"), n.long("capacity"), n.long("dropped"))),
                    decoded,
                )
                "data" -> assertEquals(name, n.string("bytes"), (decoded as OmiNotification.Data).bytes.toHexString())
                "done" -> assertEquals(name, OmiNotification.Done(n.long("status").toInt(), n.long("next")), decoded)
                "readBegin" -> assertEquals(name, OmiNotification.ReadBegin(n.long("start"), n.long("count")), decoded)
                else -> error("unknown notification $name")
            }
        }
    }

    @Test fun recordsAreRebuiltFromAnySplit() {
        val records = (0 until 3).map { record(it) }
        val stream = records.reduce(ByteArray::plus)
        val rebuilt = OmiRecordStream()
        assertTrue("bytes before a read began are dropped", rebuilt.append(stream.copyOf(10)).isEmpty())
        rebuilt.begin(50)
        val out = (stream.indices step 177).flatMap { rebuilt.append(stream.copyOfRange(it, minOf(it + 177, stream.size))) }
        assertEquals(listOf(50L, 51L, 52L), out.map { it.first })
        assertEquals(records.map { it.toList() }, out.map { it.second.toList() })
    }
}

/** A record's bytes, filled with `fill`: the phone never reads inside one. */
fun record(fill: Int) = ByteArray(OmiRecord.SIZE) { fill.toByte() }

private fun JsonObject.string(key: String) = getValue(key).jsonPrimitive.content

private fun JsonObject.long(key: String) = getValue(key).jsonPrimitive.long
