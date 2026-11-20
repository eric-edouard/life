CREATE TABLE `voice_note_hearings` (
	`claimed_at` integer NOT NULL,
	`done_at` integer,
	`key` text PRIMARY KEY NOT NULL,
	`local_text` text NOT NULL,
	`text` text
);
