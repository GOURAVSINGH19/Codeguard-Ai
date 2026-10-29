ALTER TABLE "webhook_events" ADD COLUMN "last_published_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD COLUMN "publish_attempts" integer DEFAULT 0 NOT NULL;