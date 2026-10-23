package com.ericedouard.lifelog

import java.net.URI
import java.net.URLDecoder

/**
 * What pairs the phone with a server, as the iPhone reads it (`apps/ios/Kit/Sources/ServerAPI/Pairing.swift`): the
 * link the server's Mac shows as a QR code, `lifelog://pair?url=https%3A%2F%2F…&token=…`. HTTPS only: the token
 * travels in every request.
 */
data class Pairing(val server: String, val token: String) {
    val host: String get() = URI(server).host

    companion object {
        private val tokenShape = Regex("[A-Za-z0-9_-]{16,256}")

        fun parse(link: String): Pairing? {
            val uri = runCatching { URI(link) }.getOrNull() ?: return null
            if (uri.scheme != "lifelog" || uri.host != "pair") return null
            val items = uri.rawQuery.orEmpty().split("&").associate {
                val (name, value) = (it.split("=", limit = 2) + "").take(2)
                name to URLDecoder.decode(value, "UTF-8")
            }
            val server = items["url"]?.let { runCatching { URI(it) }.getOrNull() } ?: return null
            val token = items["token"] ?: return null
            if (server.scheme != "https" || server.host == null || !tokenShape.matches(token)) return null
            return Pairing(server.toString(), token)
        }
    }
}
