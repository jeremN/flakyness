CREATE TABLE IF NOT EXISTS "flaky_tests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"test_name" varchar(500) NOT NULL,
	"test_file" varchar(500),
	"first_detected" timestamp,
	"last_seen" timestamp,
	"flake_count" integer DEFAULT 0,
	"total_runs" integer DEFAULT 0,
	"flake_rate" numeric(5, 4),
	"status" varchar(20) DEFAULT 'active'
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(255) NOT NULL,
	"gitlab_project_id" varchar(100),
	"token_hash" varchar(64),
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "projects_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "test_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"test_run_id" uuid NOT NULL,
	"test_name" varchar(500) NOT NULL,
	"test_file" varchar(500),
	"status" varchar(20) NOT NULL,
	"duration_ms" integer,
	"retry_count" integer DEFAULT 0,
	"error_message" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "test_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"branch" varchar(255) NOT NULL,
	"commit_sha" varchar(40) NOT NULL,
	"pipeline_id" varchar(100),
	"started_at" timestamp,
	"finished_at" timestamp,
	"total_tests" integer,
	"passed" integer,
	"failed" integer,
	"skipped" integer,
	"flaky" integer,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "flaky_tests" ADD CONSTRAINT "flaky_tests_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "test_results" ADD CONSTRAINT "test_results_test_run_id_test_runs_id_fk" FOREIGN KEY ("test_run_id") REFERENCES "public"."test_runs"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "test_runs" ADD CONSTRAINT "test_runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
