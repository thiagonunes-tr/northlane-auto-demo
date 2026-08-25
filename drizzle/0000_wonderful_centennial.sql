CREATE TABLE `demo_state` (
	`id` text PRIMARY KEY NOT NULL,
	`state_json` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `environment_meta` (
	`id` text PRIMARY KEY NOT NULL,
	`last_reset_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `mfa_challenges` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`role` text NOT NULL,
	`code_hash` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`consumed_at` integer
);
--> statement-breakpoint
CREATE INDEX `mfa_challenges_email_created_idx` ON `mfa_challenges` (`email`,`created_at`);--> statement-breakpoint
CREATE TABLE `pending_users` (
	`challenge_id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`name` text NOT NULL,
	`role` text NOT NULL,
	`password_hash` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `pending_users_email_idx` ON `pending_users` (`email`);--> statement-breakpoint
CREATE TABLE `users` (
	`email` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`role` text NOT NULL,
	`password_hash` text NOT NULL,
	`created_at` integer NOT NULL
);
