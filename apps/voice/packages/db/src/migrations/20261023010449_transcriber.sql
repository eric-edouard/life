ALTER TABLE `processing_switches` ADD `transcriber` text DEFAULT 'scribe' NOT NULL;--> statement-breakpoint
ALTER TABLE `transcription_jobs` ADD `transcriber` text DEFAULT 'scribe' NOT NULL;