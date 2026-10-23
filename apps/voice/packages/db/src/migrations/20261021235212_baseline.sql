CREATE TABLE `alert_push_token` (
	`id` integer PRIMARY KEY DEFAULT 1 NOT NULL,
	`push_token` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `backup_files` (
	`bytes` integer NOT NULL,
	`created_at` integer NOT NULL,
	`key` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`sha256` text NOT NULL,
	`source_id` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `backup_files_source` ON `backup_files` (`source_id`,`kind`);--> statement-breakpoint
CREATE TABLE `change_log` (
	`at` integer NOT NULL,
	`kind` text NOT NULL,
	`ref` text NOT NULL,
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL
);
--> statement-breakpoint
CREATE INDEX `change_log_kind_ref` ON `change_log` (`kind`,`ref`);--> statement-breakpoint
CREATE TABLE `chapters` (
	`conversation_id` text NOT NULL,
	`end_at` integer NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text,
	`start_at` integer NOT NULL,
	`summarized_at` integer,
	`summary` text,
	`title` text,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `chapters_conversation` ON `chapters` (`conversation_id`);--> statement-breakpoint
CREATE TABLE `conversations` (
	`capture_ended_at` integer NOT NULL,
	`capture_started_at` integer NOT NULL,
	`closed_at` integer,
	`created_at` integer NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`kind` text DEFAULT 'conversation' NOT NULL,
	`owner_title` text,
	`owner_title_at` integer,
	`retired_at` integer,
	`source_id` text,
	`state` text DEFAULT 'transcribed' NOT NULL,
	`successor_id` text,
	`turns_fp` text,
	`updated_at` integer NOT NULL,
	`waiting_reason` text,
	`waiting_since` integer
);
--> statement-breakpoint
CREATE TABLE `diagnostics` (
	`app_build` text NOT NULL,
	`app_version` text NOT NULL,
	`body` text NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`received_at` integer NOT NULL,
	`signature` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `diagnostics_received_at` ON `diagnostics` (`received_at`);--> statement-breakpoint
CREATE TABLE `embedding_calls` (
	`cost_usd` real,
	`created_at` integer NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`model` text NOT NULL,
	`purpose` text NOT NULL,
	`tokens` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `embedding_calls_created_at` ON `embedding_calls` (`created_at`);--> statement-breakpoint
CREATE TABLE `events` (
	`at` integer NOT NULL,
	`fields` text NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`source` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `events_at` ON `events` (`at`);--> statement-breakpoint
CREATE TABLE `heartbeats` (
	`body` text NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`observed_at` integer NOT NULL,
	`reason` text NOT NULL,
	`received_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `heartbeats_observed_at` ON `heartbeats` (`observed_at`);--> statement-breakpoint
CREATE INDEX `heartbeats_received_at` ON `heartbeats` (`received_at`);--> statement-breakpoint
CREATE TABLE `intelligence_calls` (
	`call` text NOT NULL,
	`created_at` integer NOT NULL,
	`key` text NOT NULL,
	`run_id` text NOT NULL,
	`stage` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `intelligence_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `intelligence_calls_once` ON `intelligence_calls` (`run_id`,`stage`,`key`);--> statement-breakpoint
CREATE TABLE `intelligence_runs` (
	`conversation_id` text NOT NULL,
	`cost_usd` real,
	`coverage` text,
	`created_at` integer NOT NULL,
	`error` text,
	`id` text PRIMARY KEY NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`latency_ms` integer,
	`model` text NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`prompt_version` integer NOT NULL,
	`provider` text NOT NULL,
	`raw` text NOT NULL,
	`reasoning_effort` text,
	`result` text,
	`state` text DEFAULT 'running' NOT NULL,
	`turns` text NOT NULL,
	`updated_at` integer NOT NULL,
	`validation_errors` text DEFAULT '[]' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `intelligence_runs_conversation` ON `intelligence_runs` (`conversation_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `intelligence_runs_one_running` ON `intelligence_runs` (`conversation_id`) WHERE state = 'running';--> statement-breakpoint
CREATE TABLE `location_history` (
	`accuracy_m` real NOT NULL,
	`arrived_at` integer,
	`created_at` integer NOT NULL,
	`departed_at` integer,
	`id` text PRIMARY KEY NOT NULL,
	`latitude` real NOT NULL,
	`longitude` real NOT NULL,
	`observed_at` integer NOT NULL,
	`place_name` text,
	`source` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `location_history_instant` ON `location_history` (`observed_at`,`source`);--> statement-breakpoint
CREATE TABLE `mac_watch` (
	`asleep` integer NOT NULL,
	`heard_at` integer NOT NULL,
	`id` integer PRIMARY KEY DEFAULT 1 NOT NULL,
	`watched_through` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `owner_edits` (
	`at` integer,
	`created_at` integer NOT NULL,
	`edited_at` integer NOT NULL,
	`from` integer,
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`source` text DEFAULT 'owner' NOT NULL,
	`target` text,
	`to` integer,
	`undone_at` integer
);
--> statement-breakpoint
CREATE TABLE `people` (
	`aliases` text NOT NULL,
	`created_at` integer NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`is_owner` integer DEFAULT false NOT NULL,
	`name` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `processing_switches` (
	`ai` integer NOT NULL,
	`engine` text DEFAULT 'claude' NOT NULL,
	`id` integer PRIMARY KEY DEFAULT 1 NOT NULL,
	`open_app_after_minutes` integer NOT NULL,
	`transcription` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `quick_transcriptions` (
	`billable_seconds` real NOT NULL,
	`created_at` integer NOT NULL,
	`duration_seconds` real NOT NULL,
	`id` text PRIMARY KEY NOT NULL
);
--> statement-breakpoint
CREATE INDEX `quick_transcriptions_created_at` ON `quick_transcriptions` (`created_at`);--> statement-breakpoint
CREATE TABLE `quiet_ranges` (
	`created_at` integer NOT NULL,
	`ended_at` integer NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`started_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `quiet_ranges_created_at` ON `quiet_ranges` (`created_at`);--> statement-breakpoint
CREATE INDEX `quiet_ranges_started_at` ON `quiet_ranges` (`started_at`);--> statement-breakpoint
CREATE TABLE `search_index` (
	`conversation_id` text PRIMARY KEY NOT NULL,
	`indexed_at` integer NOT NULL,
	`model` text NOT NULL,
	`seq` integer
);
--> statement-breakpoint
CREATE TABLE `search_passages` (
	`captured_from` integer,
	`captured_to` integer,
	`conversation_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`embedding` blob NOT NULL,
	`first_turn` integer NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`language_code` text NOT NULL,
	`last_turn` integer NOT NULL,
	`model` text NOT NULL,
	`person_ids` text NOT NULL,
	`speakers` text NOT NULL,
	`text` text NOT NULL,
	`text_hash` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `search_passages_conversation` ON `search_passages` (`conversation_id`);--> statement-breakpoint
CREATE INDEX `search_passages_captured_from` ON `search_passages` (`captured_from`);--> statement-breakpoint
CREATE TABLE `sources` (
	`created_at` integer NOT NULL,
	`dirty_from` integer,
	`dirty_to` integer,
	`handed_over_at` integer,
	`heard_through` integer,
	`id` text PRIMARY KEY NOT NULL,
	`sent_through` integer,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `speaker_assignments` (
	`candidate_id` text,
	`candidates` text,
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`margin` real,
	`mixed` integer DEFAULT false NOT NULL,
	`person_id` text,
	`score` real,
	`source` text NOT NULL,
	`speaker_label` text NOT NULL,
	`status` text NOT NULL,
	`turn_index` integer,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `transcripts`(`job_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `speaker_assignments_scope` ON `speaker_assignments` (`job_id`,`speaker_label`,coalesce(`turn_index`, -1));--> statement-breakpoint
CREATE TABLE `speech_fragments` (
	`audio_sha256` text NOT NULL,
	`capture_end` integer NOT NULL,
	`capture_start` integer NOT NULL,
	`created_at` integer NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text,
	`map` text NOT NULL,
	`object_key` text,
	`pages` text NOT NULL,
	`source_id` text NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `transcription_jobs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `speech_fragments_open` ON `speech_fragments` (`source_id`,`capture_start`) WHERE "speech_fragments"."object_key" is not null;--> statement-breakpoint
CREATE TABLE `subscription_usage` (
	`engine` text PRIMARY KEY NOT NULL,
	`reading` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `timeline_spans` (
	`end_at` integer NOT NULL,
	`facts` text NOT NULL,
	`first_page` integer NOT NULL,
	`source_id` text NOT NULL,
	`start_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`source_id`, `first_page`)
);
--> statement-breakpoint
CREATE INDEX `timeline_spans_start_at` ON `timeline_spans` (`start_at`);--> statement-breakpoint
CREATE TABLE `transcription_jobs` (
	`admitted_at` integer NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`audio_sha256` text NOT NULL,
	`billable_seconds` real NOT NULL,
	`capture_end` integer,
	`capture_start` integer,
	`completed_at` integer,
	`created_at` integer NOT NULL,
	`ended_on_silence` integer,
	`error` text,
	`id` text PRIMARY KEY NOT NULL,
	`map` text,
	`maybe_billed` integer DEFAULT false NOT NULL,
	`next_attempt_at` integer,
	`object_key` text,
	`pages` text,
	`prepared_duration_seconds` real NOT NULL,
	`provider_request_id` text,
	`provider_transcription_id` text,
	`request_sent_at` integer,
	`settings` text NOT NULL,
	`settings_hash` text NOT NULL,
	`source_id` text,
	`state` text DEFAULT 'queued' NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `transcription_jobs_provider_request_id_unique` ON `transcription_jobs` (`provider_request_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `transcription_jobs_identity` ON `transcription_jobs` (`audio_sha256`,`settings_hash`);--> statement-breakpoint
CREATE INDEX `transcription_jobs_state` ON `transcription_jobs` (`state`);--> statement-breakpoint
CREATE TABLE `transcripts` (
	`created_at` integer NOT NULL,
	`excerpts_at` integer,
	`job_id` text PRIMARY KEY NOT NULL,
	`language_code` text NOT NULL,
	`parsed` text NOT NULL,
	`parser_version` integer NOT NULL,
	`raw` text NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `transcription_jobs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `turns` (
	`end_at` integer NOT NULL,
	`job_id` text NOT NULL,
	`language` text NOT NULL,
	`speaker_label` text,
	`start_at` integer NOT NULL,
	`text` text NOT NULL,
	`turn_index` integer NOT NULL,
	`words` text NOT NULL,
	PRIMARY KEY(`job_id`, `turn_index`),
	FOREIGN KEY (`job_id`) REFERENCES `transcription_jobs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `turns_start_at` ON `turns` (`start_at`);--> statement-breakpoint
CREATE TABLE `vocabulary` (
	`created_at` integer NOT NULL,
	`term` text PRIMARY KEY NOT NULL
);
--> statement-breakpoint
CREATE TABLE `voice_profiles` (
	`created_at` integer NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`person_id` text NOT NULL,
	`sample_id` text NOT NULL,
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`sample_id`) REFERENCES `voice_samples`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `voice_profiles_sample_id_unique` ON `voice_profiles` (`sample_id`);--> statement-breakpoint
CREATE TABLE `voice_samples` (
	`conversation_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`duration_seconds` real NOT NULL,
	`embedding` text NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`model_id` text NOT NULL,
	`model_revision` text NOT NULL,
	`speaker_label` text NOT NULL,
	`turn_index` integer NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `transcripts`(`job_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `voice_samples_turn` ON `voice_samples` (`job_id`,`turn_index`);--> statement-breakpoint
CREATE TABLE `auth_account` (
	`access_token` text,
	`access_token_expires_at` integer,
	`account_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`id_token` text,
	`password` text,
	`provider_id` text NOT NULL,
	`refresh_token` text,
	`refresh_token_expires_at` integer,
	`scope` text,
	`updated_at` integer NOT NULL,
	`user_id` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `auth_user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `auth_account_user` ON `auth_account` (`user_id`);--> statement-breakpoint
CREATE TABLE `auth_jwks` (
	`alg` text,
	`created_at` integer NOT NULL,
	`crv` text,
	`expires_at` integer,
	`id` text PRIMARY KEY NOT NULL,
	`private_key` text NOT NULL,
	`public_key` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `auth_oauth_access_token` (
	`authorization_code_id` text,
	`client_id` text NOT NULL,
	`confirmation` text,
	`created_at` integer,
	`expires_at` integer,
	`id` text PRIMARY KEY NOT NULL,
	`reference_id` text,
	`requested_user_info_claims` text,
	`resources` text,
	`revoked` integer,
	`scopes` text NOT NULL,
	`session_id` text,
	`refresh_id` text,
	`token` text,
	`user_id` text,
	FOREIGN KEY (`client_id`) REFERENCES `auth_oauth_client`(`client_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`session_id`) REFERENCES `auth_session`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`refresh_id`) REFERENCES `auth_oauth_refresh_token`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `auth_user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `auth_oauth_access_token_token_unique` ON `auth_oauth_access_token` (`token`);--> statement-breakpoint
CREATE INDEX `auth_oauth_access_token_client` ON `auth_oauth_access_token` (`client_id`);--> statement-breakpoint
CREATE INDEX `auth_oauth_access_token_user` ON `auth_oauth_access_token` (`user_id`);--> statement-breakpoint
CREATE INDEX `auth_oauth_access_token_code` ON `auth_oauth_access_token` (`authorization_code_id`);--> statement-breakpoint
CREATE TABLE `auth_oauth_client` (
	`application_type` text,
	`backchannel_logout_session_required` integer,
	`backchannel_logout_uri` text,
	`client_credentials_scopes` text,
	`client_discovery_id` text,
	`client_id` text NOT NULL,
	`client_secret` text,
	`contacts` text,
	`created_at` integer,
	`disabled` integer,
	`dpop_bound_access_tokens` integer,
	`enable_end_session` integer,
	`grant_types` text,
	`icon` text,
	`id` text PRIMARY KEY NOT NULL,
	`jwks` text,
	`jwks_uri` text,
	`metadata` text,
	`name` text,
	`policy` text,
	`post_logout_redirect_uris` text,
	`redirect_uris` text NOT NULL,
	`reference_id` text,
	`require_pkce` integer,
	`response_types` text,
	`scopes` text,
	`skip_consent` integer,
	`software_id` text,
	`software_statement` text,
	`software_version` text,
	`subject_type` text,
	`token_endpoint_auth_method` text,
	`tos` text,
	`updated_at` integer,
	`uri` text,
	`user_id` text,
	FOREIGN KEY (`user_id`) REFERENCES `auth_user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `auth_oauth_client_client_id_unique` ON `auth_oauth_client` (`client_id`);--> statement-breakpoint
CREATE INDEX `auth_oauth_client_user` ON `auth_oauth_client` (`user_id`);--> statement-breakpoint
CREATE TABLE `auth_oauth_client_assertion` (
	`expires_at` integer NOT NULL,
	`id` text PRIMARY KEY NOT NULL
);
--> statement-breakpoint
CREATE TABLE `auth_oauth_client_resource` (
	`client_id` text NOT NULL,
	`created_at` integer,
	`id` text PRIMARY KEY NOT NULL,
	`metadata` text,
	`resource_id` text NOT NULL,
	FOREIGN KEY (`client_id`) REFERENCES `auth_oauth_client`(`client_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`resource_id`) REFERENCES `auth_oauth_resource`(`identifier`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `auth_oauth_client_resource_client` ON `auth_oauth_client_resource` (`client_id`);--> statement-breakpoint
CREATE INDEX `auth_oauth_client_resource_resource` ON `auth_oauth_client_resource` (`resource_id`);--> statement-breakpoint
CREATE TABLE `auth_oauth_consent` (
	`client_id` text NOT NULL,
	`created_at` integer,
	`id` text PRIMARY KEY NOT NULL,
	`reference_id` text,
	`requested_user_info_claims` text,
	`resources` text,
	`scopes` text NOT NULL,
	`updated_at` integer,
	`user_id` text,
	FOREIGN KEY (`client_id`) REFERENCES `auth_oauth_client`(`client_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `auth_user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `auth_oauth_consent_client` ON `auth_oauth_consent` (`client_id`);--> statement-breakpoint
CREATE TABLE `auth_oauth_refresh_token` (
	`authorization_code_id` text,
	`client_id` text NOT NULL,
	`confirmation` text,
	`created_at` integer,
	`expires_at` integer,
	`id` text PRIMARY KEY NOT NULL,
	`reference_id` text,
	`requested_user_info_claims` text,
	`resources` text,
	`revoked` integer,
	`scopes` text NOT NULL,
	`session_id` text,
	`auth_time` integer,
	`rotated_at` integer,
	`rotation_replay_expires_at` integer,
	`rotation_replay_response` text,
	`token` text NOT NULL,
	`user_id` text NOT NULL,
	FOREIGN KEY (`client_id`) REFERENCES `auth_oauth_client`(`client_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`session_id`) REFERENCES `auth_session`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`user_id`) REFERENCES `auth_user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `auth_oauth_refresh_token_token_unique` ON `auth_oauth_refresh_token` (`token`);--> statement-breakpoint
CREATE INDEX `auth_oauth_refresh_token_client` ON `auth_oauth_refresh_token` (`client_id`);--> statement-breakpoint
CREATE INDEX `auth_oauth_refresh_token_user` ON `auth_oauth_refresh_token` (`user_id`);--> statement-breakpoint
CREATE INDEX `auth_oauth_refresh_token_code` ON `auth_oauth_refresh_token` (`authorization_code_id`);--> statement-breakpoint
CREATE TABLE `auth_oauth_resource` (
	`access_token_ttl` integer,
	`allowed_scopes` text,
	`created_at` integer,
	`custom_claims` text,
	`disabled` integer,
	`dpop_bound_access_tokens_required` integer,
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`metadata` text,
	`name` text NOT NULL,
	`policy_version` integer,
	`refresh_token_ttl` integer,
	`signing_algorithm` text,
	`signing_key_id` text,
	`updated_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `auth_oauth_resource_identifier_unique` ON `auth_oauth_resource` (`identifier`);--> statement-breakpoint
CREATE TABLE `auth_session` (
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`ip_address` text,
	`token` text NOT NULL,
	`updated_at` integer NOT NULL,
	`user_agent` text,
	`user_id` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `auth_user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `auth_session_token_unique` ON `auth_session` (`token`);--> statement-breakpoint
CREATE INDEX `auth_session_user` ON `auth_session` (`user_id`);--> statement-breakpoint
CREATE TABLE `auth_user` (
	`created_at` integer NOT NULL,
	`email` text NOT NULL,
	`email_verified` integer NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`image` text,
	`name` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `auth_user_email_unique` ON `auth_user` (`email`);--> statement-breakpoint
CREATE TABLE `auth_verification` (
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`updated_at` integer NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `auth_verification_identifier` ON `auth_verification` (`identifier`);--> statement-breakpoint
CREATE VIEW `conversation_jobs` AS 
  select distinct c.id as conversation_id, t.job_id
  from conversations c
  join turns t on t.start_at >= c.capture_started_at and t.start_at < c.capture_ended_at
  where c.retired_at is null;--> statement-breakpoint
CREATE VIRTUAL TABLE `search_text` USING fts5(`text`, content=`search_passages`, content_rowid=`rowid`, tokenize=`trigram`);--> statement-breakpoint
CREATE TRIGGER `search_text_insert` AFTER INSERT ON `search_passages` BEGIN INSERT INTO `search_text`(rowid, `text`) VALUES (new.rowid, new.`text`); END;--> statement-breakpoint
CREATE TRIGGER `search_text_delete` AFTER DELETE ON `search_passages` BEGIN INSERT INTO `search_text`(`search_text`, rowid, `text`) VALUES ('delete', old.rowid, old.`text`); END;--> statement-breakpoint
CREATE TRIGGER `search_text_update` AFTER UPDATE OF `text` ON `search_passages` BEGIN INSERT INTO `search_text`(`search_text`, rowid, `text`) VALUES ('delete', old.rowid, old.`text`); INSERT INTO `search_text`(rowid, `text`) VALUES (new.rowid, new.`text`); END;
