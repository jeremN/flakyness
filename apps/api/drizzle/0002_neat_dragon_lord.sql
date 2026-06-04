ALTER TABLE "flaky_tests" DROP CONSTRAINT "flaky_tests_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE "test_results" DROP CONSTRAINT "test_results_test_run_id_test_runs_id_fk";
--> statement-breakpoint
ALTER TABLE "test_runs" DROP CONSTRAINT "test_runs_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE "projects" ALTER COLUMN "token_hash" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "flaky_tests" ADD CONSTRAINT "flaky_tests_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_results" ADD CONSTRAINT "test_results_test_run_id_test_runs_id_fk" FOREIGN KEY ("test_run_id") REFERENCES "public"."test_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_runs" ADD CONSTRAINT "test_runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
DELETE FROM "flaky_tests" a USING "flaky_tests" b WHERE a."project_id" = b."project_id" AND a."test_name" = b."test_name" AND a."id" < b."id";--> statement-breakpoint
CREATE UNIQUE INDEX "flaky_tests_project_test_unique" ON "flaky_tests" USING btree ("project_id","test_name");