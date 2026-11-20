-- A Scribe job the old worker had put back in the queue (a 404 at the bucket, a busy service: one minute of
-- backoff) still holds its provider ids from the POST that may have been billed, and the old worker would POST
-- it again. `legacy_scribe_sends` only marked the submitted ones: a queued one with ids fails here, marked
-- maybe billed, so no upgrade sends its audio again. The new `back` and `retry` never leave ids on a queued
-- job that was not sent (`retry` clears them). Running it twice changes nothing more.
UPDATE `transcription_jobs` SET
  `maybe_billed` = 1,
  `state` = 'failed',
  `error` = 'put back in the queue after a send that may have been billed: it is not sent again'
WHERE `state` = 'queued' AND `transcriber` = 'scribe'
  AND (`provider_request_id` IS NOT NULL OR `provider_transcription_id` IS NOT NULL);
