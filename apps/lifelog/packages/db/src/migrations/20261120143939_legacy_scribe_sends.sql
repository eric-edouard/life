-- A Scribe send's `request_sent_at` is its POST since 20 Nov 2026 (jobs.ts `dispatch`); before, it was its claim,
-- and a block could be POSTed well after it, beyond what `post_clock` allowed for. A Scribe send still submitted
-- then has no POST clock to judge it lost by, so it is marked maybe billed: never sent again, settled by its
-- webhook, its transcript or, after a day, failed (jobs.ts `settle`). Running it twice changes nothing more.
UPDATE `transcription_jobs` SET `maybe_billed` = 1
WHERE `state` = 'submitted' AND `transcriber` = 'scribe';
