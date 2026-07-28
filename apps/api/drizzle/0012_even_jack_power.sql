CREATE TABLE "team_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"role" varchar(16) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "teams" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(255) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "teams_name_unique" UNIQUE("name")
);
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "team_id" uuid;--> statement-breakpoint
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "team_members_user_team_unique" ON "team_members" USING btree ("user_id","team_id");--> statement-breakpoint
CREATE INDEX "team_members_team_id_idx" ON "team_members" USING btree ("team_id");--> statement-breakpoint
CREATE INDEX "team_members_user_id_idx" ON "team_members" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
-- Backfill (plan 057). Every project that existed before teams did is assigned
-- to an auto-created "Default" team, so nothing becomes invisible on upgrade
-- once per-team scoping turns on (plan 058).
--
-- Both statements are idempotent: ON CONFLICT covers a re-run, and the UPDATE
-- only touches rows that are still unassigned.
INSERT INTO "teams" ("name") VALUES ('Default') ON CONFLICT ("name") DO NOTHING;
--> statement-breakpoint
UPDATE "projects"
   SET "team_id" = (SELECT "id" FROM "teams" WHERE "name" = 'Default')
 WHERE "team_id" IS NULL;
