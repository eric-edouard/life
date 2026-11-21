ALTER TABLE `voice_note_hearings` ADD `billable_seconds` real;--> statement-breakpoint
ALTER TABLE `voice_note_hearings` ADD `route` text;--> statement-breakpoint
ALTER TABLE `voice_note_hearings` ADD `seconds` real;--> statement-breakpoint
CREATE INDEX `intelligence_runs_created` ON `intelligence_runs` (`created_at`);--> statement-breakpoint
CREATE INDEX `transcription_jobs_admitted` ON `transcription_jobs` (`admitted_at`);