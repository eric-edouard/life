-- Only Thai goes to Scribe now (route-turns.ts, 24 Oct 2026): the blocks waiting for ElevenLabs credits
-- (`waitsForCredits`, `UNTIL_CREDITS`) are due again once, so the speech service hears them under the new rule:
-- one it keeps local completes on the Mac; one that still needs Scribe waits again.
UPDATE `transcription_jobs` SET `next_attempt_at` = NULL, `error` = NULL
WHERE `state` = 'queued' AND `next_attempt_at` = 8640000000000000;
