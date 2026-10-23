package com.ericedouard.lifelog

import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AttemptTest {
    @Test fun aTimeoutIsAFailureNotAStop() = runBlocking {
        assertTrue(attempt { withTimeout(1) { delay(1_000) } }.isFailure)
    }

    @Test fun aStoppedCallerStops() = runBlocking {
        var carriedOn = false
        val job = launch {
            attempt { delay(1_000) }
            carriedOn = true
        }
        delay(10)
        job.cancel()
        job.join()
        assertFalse(carriedOn)
    }
}
