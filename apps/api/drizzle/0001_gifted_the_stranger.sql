CREATE INDEX IF NOT EXISTS "flaky_tests_project_status_idx" ON "flaky_tests" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "flaky_tests_flake_rate_idx" ON "flaky_tests" USING btree ("flake_rate");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "projects_token_hash_idx" ON "projects" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "test_results_test_run_id_idx" ON "test_results" USING btree ("test_run_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "test_results_test_name_idx" ON "test_results" USING btree ("test_name");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "test_results_created_at_brin_idx" ON "test_results" USING brin ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "test_runs_project_id_idx" ON "test_runs" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "test_runs_created_at_brin_idx" ON "test_runs" USING brin ("created_at");