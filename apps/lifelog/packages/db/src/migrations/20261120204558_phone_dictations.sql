CREATE TABLE `phone_dictations` (
	`ended_at` integer,
	`id` text PRIMARY KEY NOT NULL,
	`phone_id` text NOT NULL,
	`source` text NOT NULL,
	`started_at` integer NOT NULL
);
