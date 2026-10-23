DROP INDEX `raw_pages_unlabeled`;--> statement-breakpoint
CREATE INDEX `raw_pages_labeled` ON `raw_pages` (`source_id`,`labeled`,`page_index`);--> statement-breakpoint
CREATE INDEX `raw_pages_codec` ON `raw_pages` (`source_id`,`codec`);--> statement-breakpoint
-- page_pieces is made again with each piece's span (it was empty in production when this ran), and its pages are
-- labeled again. On an install with pieces this relabels its page sources' archive, Silero only: their fragments,
-- jobs and transcripts stay, and nothing is cut or sent again (held pages are never cut twice).
DROP TABLE `page_pieces`;--> statement-breakpoint
CREATE TABLE `page_pieces` (
	`audible` text DEFAULT '[]' NOT NULL,
	`breaks` text DEFAULT '[]' NOT NULL,
	`end_at` integer NOT NULL,
	`first_page` integer NOT NULL,
	`last_page` integer NOT NULL,
	`source_id` text NOT NULL,
	`span_first` integer NOT NULL,
	`speech` text NOT NULL,
	`start_at` integer NOT NULL,
	PRIMARY KEY(`source_id`, `first_page`)
);
--> statement-breakpoint
CREATE INDEX `page_pieces_last` ON `page_pieces` (`source_id`,`last_page`);--> statement-breakpoint
CREATE INDEX `page_pieces_end` ON `page_pieces` (`source_id`,`end_at`);--> statement-breakpoint
UPDATE `raw_pages` SET `labeled` = 0;--> statement-breakpoint
CREATE INDEX `page_pieces_span` ON `page_pieces` (`source_id`,`span_first`);--> statement-breakpoint
ALTER TABLE `speech_fragments` ADD `first_page` integer GENERATED ALWAYS AS (pages ->> '$[0][0]') VIRTUAL;--> statement-breakpoint
ALTER TABLE `speech_fragments` ADD `last_page` integer GENERATED ALWAYS AS (pages ->> '$[#-1][1]') VIRTUAL;--> statement-breakpoint
CREATE INDEX `speech_fragments_source_last` ON `speech_fragments` (`source_id`,`last_page`);--> statement-breakpoint
ALTER TABLE `transcription_jobs` ADD `first_page` integer GENERATED ALWAYS AS (pages ->> '$[0][0]') VIRTUAL;--> statement-breakpoint
ALTER TABLE `transcription_jobs` ADD `last_page` integer GENERATED ALWAYS AS (pages ->> '$[#-1][1]') VIRTUAL;--> statement-breakpoint
CREATE INDEX `transcription_jobs_source_last` ON `transcription_jobs` (`source_id`,`last_page`);