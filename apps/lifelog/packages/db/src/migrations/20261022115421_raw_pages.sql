CREATE TABLE `raw_pages` (
	`codec` text NOT NULL,
	`length` integer NOT NULL,
	`object_key` text NOT NULL,
	`offset` integer NOT NULL,
	`page_index` integer NOT NULL,
	`received_at` integer NOT NULL,
	`sha256` text NOT NULL,
	`source_id` text NOT NULL,
	`start_at` integer,
	PRIMARY KEY(`source_id`, `page_index`)
);
