CREATE TABLE `apple_health` (
	`activity` text,
	`created_at` integer NOT NULL,
	`end_at` integer NOT NULL,
	`id` text NOT NULL,
	`kcal` real,
	`kind` text NOT NULL,
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`stage` text,
	`start_at` integer NOT NULL,
	`value` real
);
--> statement-breakpoint
CREATE UNIQUE INDEX `apple_health_id_unique` ON `apple_health` (`id`);