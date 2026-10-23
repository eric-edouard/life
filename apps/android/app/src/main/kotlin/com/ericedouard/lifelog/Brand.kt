package com.ericedouard.lifelog

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.ExperimentalTextApi
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontVariation
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.runtime.Composable

/**
 * Life's brand (eric-edouard/life, `docs/brand.md` and `assets/brand/tokens.css`): a serif to read, mono to count,
 * monochrome, colour for status only, as a dot beside a word. Light and its derived dark, copied from the tokens.
 */
class Brand(dark: Boolean) {
    val page = Color(if (dark) 0xFF181818 else 0xFFFFFFFF)
    val surface = Color(if (dark) 0xFF242424 else 0xFFF3F3F3)
    val rule = Color(if (dark) 0xFF333333 else 0xFFE4E4E4)
    val ink = Color(if (dark) 0xFFFFFFFF else 0xFF181818)
    val muted = Color(if (dark) 0xFFA3A3A3 else 0xFF707070)

    companion object {
        val synced = Color(0xFF22C55E)
        val open = Color(0xFFF59E0B)
        val error = Color(0xFFEF4444)
        val unknown = Color(0xFF8B8F97)
        val control = 12.dp
        val panel = 18.dp

        @OptIn(ExperimentalTextApi::class)
        val serif = FontFamily(
            listOf(FontWeight.Normal, FontWeight.SemiBold).map {
                Font(R.font.source_serif_4, it, variationSettings = FontVariation.Settings(FontVariation.weight(it.weight)))
            },
        )
        val mono = FontFamily(
            Font(R.font.ibm_plex_mono_regular, FontWeight.Normal),
            Font(R.font.ibm_plex_mono_medium, FontWeight.Medium),
        )

        val current: Brand @Composable get() = Brand(isSystemInDarkTheme())
    }
}
