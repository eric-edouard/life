CREATE TABLE `page_pieces` (
	`end_at` integer NOT NULL,
	`first_page` integer NOT NULL,
	`last_page` integer NOT NULL,
	`source_id` text NOT NULL,
	`speech` text NOT NULL,
	`start_at` integer NOT NULL,
	PRIMARY KEY(`source_id`, `first_page`)
);
--> statement-breakpoint
CREATE INDEX `page_pieces_last` ON `page_pieces` (`source_id`,`last_page`);--> statement-breakpoint
CREATE INDEX `page_pieces_end` ON `page_pieces` (`source_id`,`end_at`);--> statement-breakpoint
ALTER TABLE `raw_pages` ADD `labeled` integer DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX `raw_pages_unlabeled` ON `raw_pages` (`source_id`,`page_index`) WHERE "raw_pages"."labeled" = 0;--> statement-breakpoint
CREATE INDEX `raw_pages_received` ON `raw_pages` (`source_id`,`received_at`);--> statement-breakpoint
ALTER TABLE `sources` ADD `pages_cut_from` integer;--> statement-breakpoint
CREATE INDEX `speech_fragments_source_end` ON `speech_fragments` (`source_id`,`capture_end`);--> statement-breakpoint
CREATE INDEX `transcription_jobs_source_end` ON `transcription_jobs` (`source_id`,`capture_end`);