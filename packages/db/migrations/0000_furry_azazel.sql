CREATE TYPE "public"."installation_status" AS ENUM('active', 'suspended', 'deleted');--> statement-breakpoint
CREATE TYPE "public"."repository_status" AS ENUM('active', 'inactive', 'archived');--> statement-breakpoint
CREATE TYPE "public"."pr_status" AS ENUM('open', 'closed', 'merged', 'draft');--> statement-breakpoint
CREATE TYPE "public"."review_status" AS ENUM('pending', 'in_progress', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."review_type" AS ENUM('automated', 'ai_suggested', 'paste_code');--> statement-breakpoint
CREATE TYPE "public"."comment_category" AS ENUM('security', 'bug', 'performance', 'maintainability', 'style', 'correctness', 'test_coverage', 'documentation', 'other');--> statement-breakpoint
CREATE TYPE "public"."comment_severity" AS ENUM('critical', 'high', 'medium', 'low', 'major', 'minor', 'suggestion', 'info');--> statement-breakpoint
CREATE TYPE "public"."webhook_delivery_status" AS ENUM('received', 'processing', 'processed', 'failed', 'ignored');--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"github_id" text NOT NULL,
	"github_login" text NOT NULL,
	"github_email" text,
	"avatar_url" text,
	"name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_github_id_unique" UNIQUE("github_id")
);
--> statement-breakpoint
CREATE TABLE "github_installations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"installation_id" bigint NOT NULL,
	"account_id" bigint NOT NULL,
	"account_login" text NOT NULL,
	"account_type" text NOT NULL,
	"account_avatar_url" text,
	"user_id" uuid,
	"status" "installation_status" DEFAULT 'active' NOT NULL,
	"permissions" jsonb,
	"events" jsonb,
	"suspended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "github_installations_installation_id_unique" UNIQUE("installation_id")
);
--> statement-breakpoint
CREATE TABLE "repositories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"github_repo_id" bigint NOT NULL,
	"installation_id" uuid NOT NULL,
	"full_name" text NOT NULL,
	"owner" text NOT NULL,
	"name" text NOT NULL,
	"default_branch" text DEFAULT 'main' NOT NULL,
	"is_private" boolean DEFAULT false NOT NULL,
	"language" text,
	"description" text,
	"status" "repository_status" DEFAULT 'active' NOT NULL,
	"clone_url" text,
	"html_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "repositories_github_repo_id_unique" UNIQUE("github_repo_id")
);
--> statement-breakpoint
CREATE TABLE "pull_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repository_id" uuid NOT NULL,
	"github_pr_id" bigint NOT NULL,
	"pr_number" integer NOT NULL,
	"title" text NOT NULL,
	"body" text,
	"state" "pr_status" DEFAULT 'open' NOT NULL,
	"head_branch" text NOT NULL,
	"base_branch" text NOT NULL,
	"head_sha" text NOT NULL,
	"base_sha" text NOT NULL,
	"author_github_id" text,
	"author_login" text,
	"additions" integer DEFAULT 0,
	"deletions" integer DEFAULT 0,
	"changed_files" integer DEFAULT 0,
	"labels" jsonb,
	"merged_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"github_created_at" timestamp with time zone,
	"github_updated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text,
	"pull_request_id" uuid,
	"title" text,
	"code_snippet" text,
	"language" text,
	"score" double precision,
	"status" "review_status" DEFAULT 'pending' NOT NULL,
	"review_type" "review_type" DEFAULT 'automated' NOT NULL,
	"model" text,
	"summary" text,
	"overall_score" text,
	"metadata" jsonb,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "review_comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"review_id" uuid NOT NULL,
	"file_path" text DEFAULT 'snippet',
	"line_number" integer,
	"line_start" integer,
	"line_end" integer,
	"side" text DEFAULT 'RIGHT',
	"comment" text,
	"body" text NOT NULL,
	"suggestion" text,
	"severity" "comment_severity" DEFAULT 'low' NOT NULL,
	"category" "comment_category" DEFAULT 'other' NOT NULL,
	"github_comment_id" bigint,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "code_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repository_id" uuid NOT NULL,
	"file_path" text NOT NULL,
	"language" text,
	"start_line" integer NOT NULL,
	"end_line" integer NOT NULL,
	"content" text NOT NULL,
	"summary" text,
	"commit_sha" text,
	"embedding" vector(1536),
	"token_count" integer,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"github_delivery_id" text,
	"installation_id" uuid,
	"repository_id" uuid,
	"event" text NOT NULL,
	"action" text,
	"payload" jsonb NOT NULL,
	"status" "webhook_delivery_status" DEFAULT 'received' NOT NULL,
	"error" text,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhook_events_github_delivery_id_unique" UNIQUE("github_delivery_id")
);
--> statement-breakpoint
ALTER TABLE "github_installations" ADD CONSTRAINT "github_installations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_installation_id_github_installations_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."github_installations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pull_requests" ADD CONSTRAINT "pull_requests_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_pull_request_id_pull_requests_id_fk" FOREIGN KEY ("pull_request_id") REFERENCES "public"."pull_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_comments" ADD CONSTRAINT "review_comments_review_id_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."reviews"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_chunks" ADD CONSTRAINT "code_chunks_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_installation_id_github_installations_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."github_installations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "code_chunks_embedding_idx" ON "code_chunks" USING ivfflat ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "code_chunks_repo_file_idx" ON "code_chunks" USING btree ("repository_id","file_path");