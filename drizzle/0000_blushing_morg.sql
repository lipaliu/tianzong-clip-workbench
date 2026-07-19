CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`project_date` text NOT NULL,
	`source_name` text NOT NULL,
	`mode` text NOT NULL,
	`status` text DEFAULT 'analyzing' NOT NULL,
	`clip_count` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `projects_created_at_idx` ON `projects` (`created_at`);