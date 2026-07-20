CREATE TABLE `auth_login_attempts` (
	`key` text PRIMARY KEY NOT NULL,
	`window_started_at` integer NOT NULL,
	`failure_count` integer DEFAULT 0 NOT NULL,
	`blocked_until` integer,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `auth_login_attempts_updated_at_idx` ON `auth_login_attempts` (`updated_at`);