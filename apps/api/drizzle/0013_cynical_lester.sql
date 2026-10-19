ALTER TABLE "sessions" ADD COLUMN "password_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "password_version" integer DEFAULT 0 NOT NULL;