CREATE TABLE "quarantine_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"test_name" varchar(500) NOT NULL,
	"event" varchar(20) NOT NULL,
	"source" varchar(10) NOT NULL,
	"flake_rate" numeric(5, 4),
	"threshold" numeric(5, 4),
	"ttl_days" integer,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "flaky_tests" ADD COLUMN "mute_source" varchar(10);--> statement-breakpoint
ALTER TABLE "flaky_tests" ADD COLUMN "quarantine_expires_at" timestamp;--> statement-breakpoint
ALTER TABLE "flaky_tests" ADD COLUMN "quarantine_released_at" timestamp;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "auto_quarantine_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "quarantine_threshold" numeric(5, 4);--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "quarantine_min_runs" integer;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "quarantine_ttl_days" integer;--> statement-breakpoint
ALTER TABLE "quarantine_events" ADD CONSTRAINT "quarantine_events_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "quarantine_events_project_created_idx" ON "quarantine_events" USING btree ("project_id","created_at");