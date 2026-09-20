ALTER TABLE "repositories" ALTER COLUMN "installation_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "github_installations" ADD COLUMN "github_app_id" bigint NOT NULL;--> statement-breakpoint
ALTER TABLE "github_installations" ADD COLUMN "webhook_secret" text;--> statement-breakpoint
ALTER TABLE "repositories" ADD COLUMN "auto_review_enabled" boolean DEFAULT false NOT NULL;