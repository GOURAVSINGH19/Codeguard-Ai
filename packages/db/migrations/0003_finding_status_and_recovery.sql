CREATE TYPE "public"."finding_status" AS ENUM('open', 'resolved', 'dismissed');--> statement-breakpoint
ALTER TABLE "review_comments" ADD COLUMN "source" text;--> statement-breakpoint
ALTER TABLE "review_comments" ADD COLUMN "confidence" real;--> statement-breakpoint
ALTER TABLE "review_comments" ADD COLUMN "rule_id" text;--> statement-breakpoint
ALTER TABLE "review_comments" ADD COLUMN "status" "finding_status" DEFAULT 'open' NOT NULL;--> statement-breakpoint
ALTER TABLE "review_comments" ADD COLUMN "resolved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "review_comments" ADD COLUMN "resolved_by" text;--> statement-breakpoint
ALTER TABLE "review_comments" ADD COLUMN "resolution_note" text;--> statement-breakpoint
CREATE INDEX "reviews_status_updated_idx" ON "reviews" USING btree ("status","updated_at");--> statement-breakpoint
CREATE INDEX "review_comments_review_idx" ON "review_comments" USING btree ("review_id");