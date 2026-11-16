ALTER TABLE "github_installations" ADD COLUMN "account_id" bigint NOT NULL;--> statement-breakpoint
ALTER TABLE "repositories" ADD COLUMN "html_url" text;--> statement-breakpoint
ALTER TABLE "repositories" ADD COLUMN "language" text;--> statement-breakpoint
ALTER TABLE "repositories" ADD COLUMN "description" text;