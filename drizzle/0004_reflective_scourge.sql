CREATE TABLE `clip_packaging_settings` (
	`project_id` text NOT NULL,
	`candidate_id` text NOT NULL,
	`settings` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`project_id`, `candidate_id`),
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `clip_packaging_settings_project_idx` ON `clip_packaging_settings` (`project_id`,`updated_at`);