ALTER TABLE "github_installations" DROP CONSTRAINT "github_installations_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "github_installations" ALTER COLUMN "user_id" SET DATA TYPE text;--> statement-breakpoint
-- user_id now stores the Clerk user id. Old values were users.id UUIDs that no
-- route can match, so clear them; owners are re-linked on their next install.
UPDATE "github_installations" SET "user_id" = NULL WHERE "user_id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';--> statement-breakpoint
-- Merge duplicate pull_requests rows (created by earlier races) before adding the
-- unique index: point their reviews at the oldest row, then delete the extras.
WITH ranked AS (
	SELECT "id", first_value("id") OVER (PARTITION BY "repository_id", "pr_number" ORDER BY "created_at", "id") AS keep_id
	FROM "pull_requests"
)
UPDATE "reviews" SET "pull_request_id" = ranked.keep_id
FROM ranked
WHERE "reviews"."pull_request_id" = ranked."id" AND ranked."id" <> ranked.keep_id;--> statement-breakpoint
DELETE FROM "pull_requests" p
USING "pull_requests" q
WHERE p."repository_id" = q."repository_id" AND p."pr_number" = q."pr_number"
	AND (p."created_at", p."id") > (q."created_at", q."id");--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "head_sha" text;--> statement-breakpoint
CREATE UNIQUE INDEX "pull_requests_repo_pr_number_uq" ON "pull_requests" USING btree ("repository_id","pr_number");--> statement-breakpoint
CREATE UNIQUE INDEX "reviews_pr_head_sha_active_uq" ON "reviews" USING btree ("pull_request_id","head_sha",coalesce("user_id", '')) WHERE "reviews"."head_sha" IS NOT NULL AND "reviews"."status" <> 'failed';--> statement-breakpoint
CREATE INDEX "reviews_user_created_idx" ON "reviews" USING btree ("user_id","created_at");--> statement-breakpoint
ALTER TABLE "github_installations" DROP COLUMN "webhook_secret";