-- A Scribe send's `request_sent_at` is its POST since 20 Nov 2026 (jobs.ts `dispatch`); before, it was its claim,
-- and a block the speech service left to Scribe whole was POSTed up to 10 minutes later (the speech cut-off). The
-- Scribe sends still submitted then move their clock to the latest their POST can have been, so reconcile never
-- takes one for lost (30 minutes after its POST) early and sends its audio again.
UPDATE `transcription_jobs` SET `request_sent_at` = `request_sent_at` + 600000
WHERE `state` = 'submitted' AND `transcriber` = 'scribe' AND `request_sent_at` IS NOT NULL;
