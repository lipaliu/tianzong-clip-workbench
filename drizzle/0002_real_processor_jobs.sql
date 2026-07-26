ALTER TABLE `projects` ADD `processor_job_id` text;--> statement-breakpoint
ALTER TABLE `projects` ADD `stage` text DEFAULT '等待上传' NOT NULL;--> statement-breakpoint
ALTER TABLE `projects` ADD `progress` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `projects` ADD `error` text;
