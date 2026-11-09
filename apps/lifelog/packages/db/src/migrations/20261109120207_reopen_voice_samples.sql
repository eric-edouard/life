ALTER TABLE `transcripts` ADD `excerpts_attempted_at` integer;
--> statement-breakpoint
-- Reopen held audio once; wantedTurns keeps existing samples and decides which turns remain.
UPDATE `transcripts` SET `excerpts_at` = NULL
WHERE `job_id` IN (SELECT `job_id` FROM `conversation_jobs`)
  AND EXISTS (SELECT 1 FROM `transcription_jobs` j
    WHERE j.id = transcripts.job_id AND j.object_key IS NOT NULL);
