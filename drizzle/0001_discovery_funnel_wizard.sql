CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
ALTER TYPE "public"."run_kind" ADD VALUE 'pilot';--> statement-breakpoint
CREATE TABLE "company_identifiers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"type" text NOT NULL,
	"value" text NOT NULL,
	"source" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "discovery_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"source_type" text NOT NULL,
	"name" text NOT NULL,
	"url" text,
	"query" text,
	"industry_codes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"region" text,
	"status" text DEFAULT 'unverified' NOT NULL,
	"status_reason" text,
	"origin" text DEFAULT 'seed' NOT NULL,
	"harvest_count" integer DEFAULT 0 NOT NULL,
	"pages_harvested" integer DEFAULT 0 NOT NULL,
	"last_harvested_at" timestamp with time zone,
	"reharvest_days" integer DEFAULT 90 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "run_work" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"source_id" uuid,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"found" integer DEFAULT 0 NOT NULL,
	"new_candidates" integer DEFAULT 0 NOT NULL,
	"error" text,
	"round" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "secrets" (
	"key" text PRIMARY KEY NOT NULL,
	"ciphertext" text NOT NULL,
	"iv" text NOT NULL,
	"tag" text NOT NULL,
	"last4" text,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"validated_at" timestamp with time zone,
	"validation_status" text,
	"validation_message" text
);
--> statement-breakpoint
CREATE TABLE "source_companies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"run_id" uuid,
	"was_new" boolean NOT NULL,
	"role" text,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "research_tier" text;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "screen_score" integer;--> statement-breakpoint
ALTER TABLE "feedback_imports" ADD COLUMN "kind" text DEFAULT 'feedback' NOT NULL;--> statement-breakpoint
ALTER TABLE "run_candidates" ADD COLUMN "discovery_source_id" uuid;--> statement-breakpoint
ALTER TABLE "run_candidates" ADD COLUMN "priority" integer DEFAULT 50 NOT NULL;--> statement-breakpoint
ALTER TABLE "company_identifiers" ADD CONSTRAINT "company_identifiers_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_work" ADD CONSTRAINT "run_work_run_id_research_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."research_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_companies" ADD CONSTRAINT "source_companies_source_id_discovery_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."discovery_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_companies" ADD CONSTRAINT "source_companies_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "identifier_uniq" ON "company_identifiers" USING btree ("company_id","type","value");--> statement-breakpoint
CREATE INDEX "identifier_lookup_idx" ON "company_identifiers" USING btree ("type","value");--> statement-breakpoint
CREATE UNIQUE INDEX "source_url_uniq" ON "discovery_sources" USING btree ("url") WHERE "discovery_sources"."url" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "source_query_uniq" ON "discovery_sources" USING btree ("query") WHERE "discovery_sources"."query" is not null;--> statement-breakpoint
CREATE INDEX "run_work_run_idx" ON "run_work" USING btree ("run_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "source_company_uniq" ON "source_companies" USING btree ("source_id","company_id");--> statement-breakpoint
CREATE INDEX "source_company_company_idx" ON "source_companies" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "company_name_trgm_idx" ON "companies" USING gin ("normalized_name" gin_trgm_ops);