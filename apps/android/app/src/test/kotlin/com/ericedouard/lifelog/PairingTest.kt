package com.ericedouard.lifelog

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Test
import java.io.File

class PairingTest {
    /** The cases the server, the iPhone and this app share (`fixtures/wire/pairing-links.json`). */
    @Test fun readsTheSharedLinks() {
        val cases = Json.parseToJsonElement(File("../../../fixtures/wire/pairing-links.json").readText()).jsonArray
        for (case in cases.map { it.jsonObject }) {
            val expected = case["pairing"].takeUnless { it == JsonNull }?.jsonObject?.let {
                Pairing(it["server"]!!.jsonPrimitive.content, it["token"]!!.jsonPrimitive.content)
            }
            assertEquals(case["case"]!!.jsonPrimitive.content, expected, Pairing.parse(case["link"]!!.jsonPrimitive.content))
        }
    }
}
