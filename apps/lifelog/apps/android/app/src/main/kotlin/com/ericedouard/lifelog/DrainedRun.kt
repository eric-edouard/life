package com.ericedouard.lifelog

/**
 * One read's records on their way to the outbox, and how far the Omi may be advanced: one past the contiguous run of
 * ring numbers stored from the read's start, never across a hole and never past a record whose `store` failed.
 */
class DrainedRun(private val start: Long, private val store: (List<Pair<Long, ByteArray>>) -> Unit) {
    private var pending = mutableListOf<Pair<Long, ByteArray>>()
    private var end = start

    var stored = 0
        private set

    /** Where ADVANCE may go; null while nothing past the start is stored. */
    val advanceTo: Long? get() = end.takeIf { it > start }

    fun add(records: List<Pair<Long, ByteArray>>) {
        pending += records
    }

    /** Stores what is pending. If `store` throws, it stays pending and nothing moves. */
    fun flush() {
        if (pending.isEmpty()) return
        store(pending)
        for ((seq, _) in pending) if (seq == end) end++
        stored += pending.size
        pending = mutableListOf()
    }
}
