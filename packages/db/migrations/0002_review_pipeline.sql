CREATE TABLE "review_findings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"review_id" uuid NOT NULL,
	"file" text,
	"line" integer,
	"severity" text NOT NULL,
	"category" text NOT NULL,
	"message" text NOT NULL,
	"suggestion" text,
	"source" text DEFAULT 'ai' NOT NULL,
	"confidence" real,
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "installation_id" bigint;--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "progress" text;--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "trigger" text DEFAULT 'webhook' NOT NULL;--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "review_type" text DEFAULT 'pr' NOT NULL;--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "pr_title" text;--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "pull_request" jsonb;--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "base_sha" text;--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "reviewed_from_sha" text;--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "error" text;--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "model" text;--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "tokens" integer;--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "duration_ms" integer;--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "check_run_id" bigint;--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "github_review_url" text;--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "assurance" jsonb;--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "review_findings" ADD CONSTRAINT "review_findings_review_id_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."reviews"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "review_findings_review_idx" ON "review_findings" USING btree ("review_id");--> statement-breakpoint
CREATE INDEX "reviews_status_idx" ON "reviews" USING btree ("status");