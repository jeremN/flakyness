CREATE TABLE "audit_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"audit_run_id" uuid NOT NULL,
	"url" varchar(2048) NOT NULL,
	"device" varchar(16) NOT NULL,
	"category" varchar(16) NOT NULL,
	"score" numeric(5, 4),
	"metrics" jsonb,
	"issues" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"branch" varchar(255) NOT NULL,
	"commit_sha" varchar(40),
	"pipeline_id" varchar(100),
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"page_count" integer NOT NULL,
	"failed_pages" integer DEFAULT 0 NOT NULL,
	"page_errors" jsonb,
	"tool_name" varchar(100),
	"tool_version" varchar(50),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_results" ADD CONSTRAINT "audit_results_audit_run_id_audit_runs_id_fk" FOREIGN KEY ("audit_run_id") REFERENCES "public"."audit_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_runs" ADD CONSTRAINT "audit_runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_results_audit_run_id_idx" ON "audit_results" USING btree ("audit_run_id");--> statement-breakpoint
CREATE INDEX "audit_runs_project_created_idx" ON "audit_runs" USING btree ("project_id","created_at");