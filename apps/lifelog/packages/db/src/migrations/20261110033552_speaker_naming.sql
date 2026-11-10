CREATE TABLE `life_people_snapshot` (
	`folds` text NOT NULL,
	`hash` text NOT NULL,
	`id` integer PRIMARY KEY DEFAULT 1 NOT NULL,
	`people` text NOT NULL,
	`revision` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `naming_attempts` (
	`attempts` integer DEFAULT 0 NOT NULL,
	`call` text,
	`conversation_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`engine` text DEFAULT 'codex' NOT NULL,
	`error` text,
	`id` text PRIMARY KEY NOT NULL,
	`input_hash` text NOT NULL,
	`model` text NOT NULL,
	`next_eligible_at` integer,
	`policy_hash` text NOT NULL,
	`prompt_hash` text NOT NULL,
	`result` text,
	`snapshot_revision` integer NOT NULL,
	`state` text DEFAULT 'queued' NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `naming_attempts_input` ON `naming_attempts` (`conversation_id`,`input_hash`);--> statement-breakpoint
CREATE TABLE `naming_rollout` (
	`created_at` integer NOT NULL,
	`gate` text,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`latency_ms` integer DEFAULT 0 NOT NULL,
	`long_window` text,
	`model` text NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`pilot_calls` integer DEFAULT 0 NOT NULL,
	`pilot_passed` integer DEFAULT false NOT NULL,
	`policy_hash` text PRIMARY KEY NOT NULL,
	`prompt_hash` text NOT NULL,
	`short_window` text,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `people` ADD `creation_source` text DEFAULT 'owner' NOT NULL;--> statement-breakpoint
ALTER TABLE `people` ADD `life_ref` text;--> statement-breakpoint
CREATE UNIQUE INDEX `people_life_ref_unique` ON `people` (`life_ref`);--> statement-breakpoint
ALTER TABLE `speaker_assignments` ADD `inference` text;
--> statement-breakpoint
ALTER TABLE `people` ADD `name_source` text DEFAULT 'owner' NOT NULL;
