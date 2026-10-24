ALTER TABLE `mac_watch` ADD `last_at` integer;--> statement-breakpoint
ALTER TABLE `mac_watch` ADD `last_seq` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `mac_watch` ADD `state` text DEFAULT '{"asleep":false,"blockedSince":null,"finished":null,"interrupted":false,"lostFrom":null,"open":null}' NOT NULL;--> statement-breakpoint
-- The cutover from the helper's protocol 1 keeps its word: a watermark held behind the last time the Mac
-- was heard (a dictation under way, or a range not yet stored) stays held until the new helper's
-- first event applies; an asleep Mac stays asleep until its hello.
UPDATE `mac_watch` SET `state` = json_set(`state`, '$.blockedSince', `watched_through`) WHERE `watched_through` < `heard_at`;--> statement-breakpoint
UPDATE `mac_watch` SET `state` = json_set(`state`, '$.asleep', json('true')) WHERE `asleep` = 1;--> statement-breakpoint
ALTER TABLE `mac_watch` DROP COLUMN `asleep`;--> statement-breakpoint
ALTER TABLE `mac_watch` DROP COLUMN `watched_through`;
