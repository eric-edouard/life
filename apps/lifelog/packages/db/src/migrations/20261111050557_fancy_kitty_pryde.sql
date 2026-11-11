DELETE FROM `apple_health` WHERE `kind` NOT IN ('sleep', 'workout');--> statement-breakpoint
ALTER TABLE `apple_health` DROP COLUMN `value`;