CREATE TABLE "quarantine_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"name" varchar(255),
	"enabled" boolean DEFAULT true NOT NULL,
	"selector_branch" varchar(255),
	"selector_file" varchar(500),
	"selector_tag" varchar(255),
	"action" varchar(16) NOT NULL,
	"condition_type" varchar(16),
	"flake_threshold" numeric(5, 4),
	"min_runs" integer,
	"window_days" integer,
	"consecutive_failures" integer,
	"ttl_days" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "quarantine_events" ADD COLUMN "rule_id" uuid;--> statement-breakpoint
ALTER TABLE "quarantine_rules" ADD CONSTRAINT "quarantine_rules_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "quarantine_rules_project_position_idx" ON "quarantine_rules" USING btree ("project_id","position");--> statement-breakpoint
ALTER TABLE "quarantine_events" ADD CONSTRAINT "quarantine_events_rule_id_quarantine_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."quarantine_rules"("id") ON DELETE set null ON UPDATE no action;