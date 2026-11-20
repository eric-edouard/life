-- A Scribe job the old worker had put back in the queue is not sent again by the new one: its POST may have
-- been billed, and the old worker would POST it again. Two kinds: one still holding its provider ids (a busy
-- service, a bucket 404: one minute of backoff), and one the old `retry` cleared of them after calling a slow
-- POST lost ("lost by the provider", `legacy_scribe_sends` only matched submitted ones). Each fails, marked maybe
-- billed, and is logged in the feed (`change-log.ts`) in this same transaction. The new `retry` has the same
-- error but only after a POST clock said it lost, and the migration has run by then. Running it twice changes nothing more.
INSERT INTO `change_log` (`kind`, `ref`, `at`)
SELECT 'job', `id`, CAST(strftime('%s', 'now') AS integer) * 1000 FROM `transcription_jobs`
WHERE `state` = 'queued' AND `transcriber` = 'scribe'
  AND (`provider_request_id` IS NOT NULL OR `provider_transcription_id` IS NOT NULL OR `error` LIKE 'lost by the provider%');
--> statement-breakpoint
UPDATE `transcription_jobs` SET
  `maybe_billed` = 1,
  `state` = 'failed',
  `error` = 'put back in the queue after a send that may have been billed: it is not sent again'
WHERE `state` = 'queued' AND `transcriber` = 'scribe'
  AND (`provider_request_id` IS NOT NULL OR `provider_transcription_id` IS NOT NULL OR `error` LIKE 'lost by the provider%');
