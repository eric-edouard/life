package com.ericedouard.lifelog

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Test

class DrainedRunTest {
    private fun records(vararg seqs: Long) = seqs.map { it to record(it.toInt()) }

    @Test fun advanceStopsAtTheFirstHole() {
        val run = DrainedRun(5) {}
        run.add(records(5, 6, 7, 9))
        run.flush()
        assertEquals(8L, run.advanceTo)
        assertEquals(4, run.stored)
    }

    @Test fun nothingPastTheStartAdvancesNothing() {
        val run = DrainedRun(5) {}
        run.add(records(3, 4))
        run.flush()
        assertNull(run.advanceTo)
    }

    @Test fun aFailedStoreNeverMovesTheAdvance() {
        var failing = true
        val run = DrainedRun(0) { if (failing) error("disk full") }
        run.add(records(0, 1))
        assertThrows(IllegalStateException::class.java) { run.flush() }
        assertNull(run.advanceTo)
        failing = false
        run.flush()
        assertEquals(2L, run.advanceTo)
    }
}
