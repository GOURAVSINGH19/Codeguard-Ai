CREATE TABLE "code_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repository_id" uuid NOT NULL,
	"path" text NOT NULL,
	"symbol" text,
	"start_line" integer NOT NULL,
	"end_line" integer NOT NULL,
	"content" text NOT NULL,
	"embedding" vector(384) NOT NULL,
	"commit_sha" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "code_files" (
	"repository_id" uuid NOT NULL,
	"path" text NOT NULL,
	"blob_sha" text NOT NULL,
	"imports" text[] DEFAULT '{}' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "code_files_repository_id_path_pk" PRIMARY KEY("repository_id","path")
);
--> statement-breakpoint
ALTER TABLE "repositories" ADD COLUMN "default_branch" text;--> statement-breakpoint
ALTER TABLE "repositories" ADD COLUMN "indexed_sha" text;--> statement-breakpoint
ALTER TABLE "repositories" ADD COLUMN "indexed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "code_chunks" ADD CONSTRAINT "code_chunks_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_files" ADD CONSTRAINT "code_files_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "code_chunks_repo_path_idx" ON "code_chunks" USING btree ("repository_id","path");--> statement-breakpoint
CREATE INDEX "code_chunks_embedding_idx" ON "code_chunks" USING hnsw ("embedding" vector_cosine_ops);