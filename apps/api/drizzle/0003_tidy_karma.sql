ALTER TABLE "projects" ADD COLUMN "flake_threshold" numeric(5, 4);--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "window_days" integer;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "min_runs" integer;