CREATE TABLE `phone_dictations` (
	`ended_at` integer,
	`id` text PRIMARY KEY NOT NULL,
	`phone_id` text NOT NULL,
	`source` text NOT NULL,
	`started_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `phone_dictations_started_at` ON `phone_dictations` (`started_at`);--> statement-breakpoint
CREATE TABLE `source_clocks` (
	`measured_at` integer NOT NULL,
	`offset_ms` integer NOT NULL,
	`source_id` text PRIMARY KEY NOT NULL,
	`uncertainty_ms` integer NOT NULL
);
