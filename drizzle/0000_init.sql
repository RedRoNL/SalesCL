CREATE TYPE "public"."call_outcome" AS ENUM('not_yet_called', 'no_answer', 'gatekeeper', 'wrong_contact', 'not_interested', 'existing_supplier', 'no_microsoft_environment', 'no_purchasing_authority', 'contact_again_later', 'qualified_opportunity', 'appointment_scheduled', 'converted_to_customer', 'do_not_contact');--> statement-breakpoint
CREATE TYPE "public"."company_status" AS ENUM('candidate', 'researching', 'researched', 'qualified', 'needs_research', 'rejected', 'approved', 'exported', 'excluded');--> statement-breakpoint
CREATE TYPE "public"."contact_eligibility" AS ENUM('eligible', 'restricted', 'unknown', 'suppressed');--> statement-breakpoint
CREATE TYPE "public"."evidence_class" AS ENUM('confirmed', 'strongly_indicated', 'weakly_indicated', 'unknown', 'contradicted');--> statement-breakpoint
CREATE TYPE "public"."exclusion_scope" AS ENUM('company', 'domain', 'parent_company', 'legal_entity', 'sector', 'name');--> statement-breakpoint
CREATE TYPE "public"."list_item_status" AS ENUM('pending', 'approved', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."list_status" AS ENUM('draft', 'in_review', 'approved', 'exported');--> statement-breakpoint
CREATE TYPE "public"."ms_technology" AS ENUM('microsoft_365', 'exchange_online', 'entra_id', 'azure', 'intune', 'defender', 'purview', 'copilot', 'sharepoint_online', 'teams');--> statement-breakpoint
CREATE TYPE "public"."qa_verdict" AS ENUM('approved', 'rejected', 'needs_research');--> statement-breakpoint
CREATE TYPE "public"."recommendation_status" AS ENUM('proposed', 'approved', 'rejected', 'applied');--> statement-breakpoint
CREATE TYPE "public"."relationship_type" AS ENUM('none', 'customer', 'active_opportunity', 'prior_prospect', 'rejected', 'opted_out');--> statement-breakpoint
CREATE TYPE "public"."run_kind" AS ENUM('weekly', 'manual', 'sector', 'company', 'chat');--> statement-breakpoint
CREATE TYPE "public"."run_status" AS ENUM('queued', 'running', 'paused', 'cancelled', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."task_status" AS ENUM('queued', 'running', 'succeeded', 'failed', 'cancelled', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('admin', 'analyst', 'viewer');--> statement-breakpoint
CREATE TABLE "agent_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"thread_id" uuid NOT NULL,
	"from_agent" text,
	"to_agent" text,
	"user_id" text,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"task_id" uuid,
	"run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_performance_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" text NOT NULL,
	"period_start" date NOT NULL,
	"metrics" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid,
	"agent_id" text NOT NULL,
	"parent_task_id" uuid,
	"company_id" uuid,
	"task_type" text NOT NULL,
	"status" "task_status" DEFAULT 'queued' NOT NULL,
	"input" jsonb,
	"output" jsonb,
	"error" text,
	"model" text,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cache_read_tokens" integer DEFAULT 0 NOT NULL,
	"tool_calls" integer DEFAULT 0 NOT NULL,
	"cost_eur" numeric(12, 4) DEFAULT '0' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "appointments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"calling_result_id" uuid,
	"scheduled_for" timestamp with time zone,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"action" text NOT NULL,
	"entity_type" text,
	"entity_id" text,
	"details" jsonb,
	"ip" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "buying_signals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"signal_type" text NOT NULL,
	"title" text NOT NULL,
	"explanation" text NOT NULL,
	"relevance" text NOT NULL,
	"commercial_assessment" text NOT NULL,
	"signal_date" date,
	"source_id" uuid,
	"recorded_by" text,
	"run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "calling_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"import_id" uuid,
	"outcome" "call_outcome" NOT NULL,
	"notes" text,
	"called_at" timestamp with time zone,
	"contact_role" text,
	"raw" jsonb,
	"row_hash" text NOT NULL,
	"superseded_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "companies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"prospect_number" serial NOT NULL,
	"official_name" text NOT NULL,
	"trading_name" text,
	"normalized_name" text NOT NULL,
	"website" text,
	"canonical_domain" text,
	"industry_id" integer,
	"sub_industry" text,
	"hq_city" text,
	"hq_country" text,
	"nl_office_city" text,
	"province" text,
	"employee_count" integer,
	"employee_min" integer,
	"employee_max" integer,
	"employee_source_id" uuid,
	"group_id" uuid,
	"legal_form" text,
	"kvk_number" text,
	"phone_public" text,
	"phone_source_id" uuid,
	"purchasing_authority" text DEFAULT 'unknown',
	"status" "company_status" DEFAULT 'candidate' NOT NULL,
	"relationship" "relationship_type" DEFAULT 'none' NOT NULL,
	"contact_eligibility" "contact_eligibility" DEFAULT 'unknown' NOT NULL,
	"eligibility_reason" text,
	"eligibility_checked_at" timestamp with time zone,
	"assigned_agent" text,
	"discovered_by" text,
	"discovered_run_id" uuid,
	"latest_score_id" uuid,
	"fit_score" integer,
	"confidence_score" integer,
	"classification" text,
	"recommended_service" text,
	"reactivation_approved" boolean DEFAULT false NOT NULL,
	"last_researched_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "companies_prospect_number_unique" UNIQUE("prospect_number")
);
--> statement-breakpoint
CREATE TABLE "company_aliases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"alias" text NOT NULL,
	"normalized_alias" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "company_facts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"field" text NOT NULL,
	"value" jsonb NOT NULL,
	"source_id" uuid,
	"confidence" real NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"recorded_by" text,
	"superseded_by_id" uuid
);
--> statement-breakpoint
CREATE TABLE "company_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"normalized_name" text NOT NULL,
	"primary_domain" text,
	"hq_country" text,
	"it_purchasing_location" text DEFAULT 'unknown',
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"full_name" text,
	"role_title" text NOT NULL,
	"role_category" text,
	"source_id" uuid,
	"lawful_basis" text DEFAULT 'legitimate_interest_b2b_public_professional_role' NOT NULL,
	"retention_until" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"service" text NOT NULL,
	"contracted_mrr_eur" numeric(10, 2),
	"signed_at" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"list_id" uuid,
	"export_id" uuid,
	"delivered_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "domains" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"domain" text NOT NULL,
	"company_id" uuid,
	"group_id" uuid,
	"is_primary" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "exclusions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope" "exclusion_scope" NOT NULL,
	"value" text NOT NULL,
	"normalized_value" text NOT NULL,
	"category" text NOT NULL,
	"reason" text NOT NULL,
	"permanent" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "exports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"list_id" uuid,
	"format" text NOT NULL,
	"file_name" text NOT NULL,
	"row_count" integer NOT NULL,
	"content_hash" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feedback_imports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"file_name" text NOT NULL,
	"uploaded_by" text NOT NULL,
	"status" text DEFAULT 'preview' NOT NULL,
	"mapping" jsonb,
	"row_count" integer DEFAULT 0 NOT NULL,
	"valid_rows" integer DEFAULT 0 NOT NULL,
	"duplicate_rows" integer DEFAULT 0 NOT NULL,
	"errors" jsonb DEFAULT '[]'::jsonb,
	"preview" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"committed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "industries" (
	"id" serial PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"name_nl" text NOT NULL,
	"name_en" text NOT NULL,
	"priority_tier" integer DEFAULT 2 NOT NULL,
	"nis2_sector" text,
	"dora_applicable" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"estimated_pool_size" integer,
	"pool_estimate_source" text,
	"notes" text,
	CONSTRAINT "industries_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "legal_entities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid,
	"name" text NOT NULL,
	"normalized_name" text NOT NULL,
	"kvk_number" text,
	"legal_form" text,
	"source_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "market_segments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"industry_id" integer,
	"region" text,
	"size_band" text,
	"description" text,
	"sources_used" jsonb DEFAULT '[]'::jsonb,
	"queries_used" jsonb DEFAULT '[]'::jsonb,
	"candidates_found" integer DEFAULT 0 NOT NULL,
	"qualified_found" integer DEFAULT 0 NOT NULL,
	"exhaustion_estimate" real,
	"last_researched_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "opportunities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"service" text NOT NULL,
	"stage" text DEFAULT 'open' NOT NULL,
	"estimated_mrr_eur" numeric(10, 2),
	"source" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "prospect_list_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"list_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"rank" integer NOT NULL,
	"priority" text NOT NULL,
	"status" "list_item_status" DEFAULT 'pending' NOT NULL,
	"decided_by" text,
	"decision_reason" text,
	"contact_role" text,
	"contact_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "prospect_lists" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"iso_week" text NOT NULL,
	"run_id" uuid,
	"status" "list_status" DEFAULT 'draft' NOT NULL,
	"target" integer DEFAULT 100 NOT NULL,
	"shortfall" integer DEFAULT 0 NOT NULL,
	"shortfall_explanation" text,
	"qa_report" jsonb,
	"management_summary" text,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"operation" text NOT NULL,
	"units" real DEFAULT 1 NOT NULL,
	"cost_eur" numeric(12, 4) DEFAULT '0' NOT NULL,
	"cached" boolean DEFAULT false NOT NULL,
	"run_id" uuid,
	"agent_task_id" uuid,
	"agent_id" text,
	"company_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "qa_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"run_id" uuid,
	"verdict" "qa_verdict" NOT NULL,
	"checks" jsonb NOT NULL,
	"issues" jsonb NOT NULL,
	"reviewer" text NOT NULL,
	"overridden_by" text,
	"override_reason" text,
	"overridden_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "qualification_scores" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"scoring_config_id" uuid,
	"run_id" uuid,
	"fit_score" integer NOT NULL,
	"confidence_score" integer NOT NULL,
	"components" jsonb NOT NULL,
	"classification" text NOT NULL,
	"recommended_service" text NOT NULL,
	"rationale" text NOT NULL,
	"missing_information" jsonb NOT NULL,
	"hard_failures" jsonb NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recommendations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"content" text NOT NULL,
	"evidence_strength" text NOT NULL,
	"evidence" jsonb,
	"proposed_change" jsonb,
	"requires_approval" boolean DEFAULT true NOT NULL,
	"status" "recommendation_status" DEFAULT 'proposed' NOT NULL,
	"decided_by" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "research_cache" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"cache_key" text NOT NULL,
	"response" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "research_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "run_kind" NOT NULL,
	"status" "run_status" DEFAULT 'queued' NOT NULL,
	"idempotency_key" text,
	"params" jsonb NOT NULL,
	"strategy" jsonb,
	"stage" text,
	"target_prospects" integer DEFAULT 100 NOT NULL,
	"budget_eur" numeric(10, 2),
	"cost_eur" numeric(12, 4) DEFAULT '0' NOT NULL,
	"stats" jsonb DEFAULT '{}'::jsonb,
	"error" text,
	"pause_reason" text,
	"triggered_by" text NOT NULL,
	"management_summary" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"heartbeat_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "research_runs_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "research_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid,
	"url" text NOT NULL,
	"title" text,
	"source_type" text NOT NULL,
	"provider" text NOT NULL,
	"content_hash" text,
	"excerpt" text,
	"http_status" integer,
	"retrieved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"run_id" uuid
);
--> statement-breakpoint
CREATE TABLE "run_candidates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"stage" text DEFAULT 'discovered' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"hunter" text,
	"last_error" text,
	"outcome" text,
	"checkpoint" jsonb DEFAULT '{}'::jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scoring_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"version" integer NOT NULL,
	"weights" jsonb NOT NULL,
	"thresholds" jsonb NOT NULL,
	"rules" jsonb NOT NULL,
	"active" boolean DEFAULT false NOT NULL,
	"notes" text,
	"created_by" text,
	"approved_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scoring_configs_version_unique" UNIQUE("version")
);
--> statement-breakpoint
CREATE TABLE "strategies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"version" integer NOT NULL,
	"content" jsonb NOT NULL,
	"created_by_agent" text,
	"run_id" uuid,
	"approved" boolean DEFAULT true NOT NULL,
	"approved_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "strategies_version_unique" UNIQUE("version")
);
--> statement-breakpoint
CREATE TABLE "suppressions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"identifier_type" text NOT NULL,
	"identifier_value" text NOT NULL,
	"reason" text NOT NULL,
	"source" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "system_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "technology_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"technology" "ms_technology" NOT NULL,
	"classification" "evidence_class" NOT NULL,
	"evidence_type" text NOT NULL,
	"detail" text NOT NULL,
	"source_id" uuid,
	"recorded_by" text,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"run_id" uuid
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"name" text,
	"role" "user_role" DEFAULT 'viewer' NOT NULL,
	"entra_object_id" text,
	"active" boolean DEFAULT true NOT NULL,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_entra_object_id_unique" UNIQUE("entra_object_id")
);
--> statement-breakpoint
ALTER TABLE "agent_tasks" ADD CONSTRAINT "agent_tasks_run_id_research_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."research_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_tasks" ADD CONSTRAINT "agent_tasks_parent_task_id_agent_tasks_id_fk" FOREIGN KEY ("parent_task_id") REFERENCES "public"."agent_tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_tasks" ADD CONSTRAINT "agent_tasks_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_calling_result_id_calling_results_id_fk" FOREIGN KEY ("calling_result_id") REFERENCES "public"."calling_results"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "buying_signals" ADD CONSTRAINT "buying_signals_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "buying_signals" ADD CONSTRAINT "buying_signals_source_id_research_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."research_sources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calling_results" ADD CONSTRAINT "calling_results_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calling_results" ADD CONSTRAINT "calling_results_import_id_feedback_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."feedback_imports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calling_results" ADD CONSTRAINT "calling_results_superseded_by_id_calling_results_id_fk" FOREIGN KEY ("superseded_by_id") REFERENCES "public"."calling_results"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "companies" ADD CONSTRAINT "companies_industry_id_industries_id_fk" FOREIGN KEY ("industry_id") REFERENCES "public"."industries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "companies" ADD CONSTRAINT "companies_group_id_company_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."company_groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_aliases" ADD CONSTRAINT "company_aliases_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_facts" ADD CONSTRAINT "company_facts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_facts" ADD CONSTRAINT "company_facts_source_id_research_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."research_sources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_facts" ADD CONSTRAINT "company_facts_superseded_by_id_company_facts_id_fk" FOREIGN KEY ("superseded_by_id") REFERENCES "public"."company_facts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversions" ADD CONSTRAINT "conversions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_list_id_prospect_lists_id_fk" FOREIGN KEY ("list_id") REFERENCES "public"."prospect_lists"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_export_id_exports_id_fk" FOREIGN KEY ("export_id") REFERENCES "public"."exports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domains" ADD CONSTRAINT "domains_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domains" ADD CONSTRAINT "domains_group_id_company_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."company_groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exports" ADD CONSTRAINT "exports_list_id_prospect_lists_id_fk" FOREIGN KEY ("list_id") REFERENCES "public"."prospect_lists"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_entities" ADD CONSTRAINT "legal_entities_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_segments" ADD CONSTRAINT "market_segments_industry_id_industries_id_fk" FOREIGN KEY ("industry_id") REFERENCES "public"."industries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prospect_list_items" ADD CONSTRAINT "prospect_list_items_list_id_prospect_lists_id_fk" FOREIGN KEY ("list_id") REFERENCES "public"."prospect_lists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prospect_list_items" ADD CONSTRAINT "prospect_list_items_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prospect_lists" ADD CONSTRAINT "prospect_lists_run_id_research_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."research_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qa_reviews" ADD CONSTRAINT "qa_reviews_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qualification_scores" ADD CONSTRAINT "qualification_scores_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qualification_scores" ADD CONSTRAINT "qualification_scores_scoring_config_id_scoring_configs_id_fk" FOREIGN KEY ("scoring_config_id") REFERENCES "public"."scoring_configs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_sources" ADD CONSTRAINT "research_sources_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_candidates" ADD CONSTRAINT "run_candidates_run_id_research_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."research_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_candidates" ADD CONSTRAINT "run_candidates_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "technology_evidence" ADD CONSTRAINT "technology_evidence_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "technology_evidence" ADD CONSTRAINT "technology_evidence_source_id_research_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."research_sources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "msg_thread_idx" ON "agent_messages" USING btree ("thread_id","created_at");--> statement-breakpoint
CREATE INDEX "msg_agent_idx" ON "agent_messages" USING btree ("to_agent");--> statement-breakpoint
CREATE INDEX "task_agent_idx" ON "agent_tasks" USING btree ("agent_id","created_at");--> statement-breakpoint
CREATE INDEX "task_run_idx" ON "agent_tasks" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "task_status_idx" ON "agent_tasks" USING btree ("status");--> statement-breakpoint
CREATE INDEX "audit_entity_idx" ON "audit_logs" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "audit_created_idx" ON "audit_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "signal_company_idx" ON "buying_signals" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "signal_type_idx" ON "buying_signals" USING btree ("signal_type");--> statement-breakpoint
CREATE INDEX "call_company_idx" ON "calling_results" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "call_row_hash_uniq" ON "calling_results" USING btree ("row_hash");--> statement-breakpoint
CREATE INDEX "company_norm_name_idx" ON "companies" USING btree ("normalized_name");--> statement-breakpoint
CREATE UNIQUE INDEX "company_domain_uniq" ON "companies" USING btree ("canonical_domain") WHERE "companies"."canonical_domain" is not null and "companies"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "company_kvk_uniq" ON "companies" USING btree ("kvk_number") WHERE "companies"."kvk_number" is not null and "companies"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "company_status_idx" ON "companies" USING btree ("status");--> statement-breakpoint
CREATE INDEX "company_industry_idx" ON "companies" USING btree ("industry_id");--> statement-breakpoint
CREATE INDEX "company_group_idx" ON "companies" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "alias_norm_idx" ON "company_aliases" USING btree ("normalized_alias");--> statement-breakpoint
CREATE INDEX "fact_company_field_idx" ON "company_facts" USING btree ("company_id","field");--> statement-breakpoint
CREATE INDEX "delivery_company_idx" ON "deliveries" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "domain_uniq" ON "domains" USING btree ("domain");--> statement-breakpoint
CREATE INDEX "exclusion_lookup_idx" ON "exclusions" USING btree ("scope","normalized_value");--> statement-breakpoint
CREATE INDEX "segment_industry_idx" ON "market_segments" USING btree ("industry_id");--> statement-breakpoint
CREATE UNIQUE INDEX "list_item_uniq" ON "prospect_list_items" USING btree ("list_id","company_id");--> statement-breakpoint
CREATE INDEX "usage_created_idx" ON "provider_usage" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "usage_run_idx" ON "provider_usage" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "qa_company_idx" ON "qa_reviews" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "score_company_idx" ON "qualification_scores" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "cache_key_uniq" ON "research_cache" USING btree ("provider","cache_key");--> statement-breakpoint
CREATE INDEX "run_status_idx" ON "research_runs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "source_company_idx" ON "research_sources" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "source_url_idx" ON "research_sources" USING btree ("url");--> statement-breakpoint
CREATE UNIQUE INDEX "run_candidate_uniq" ON "run_candidates" USING btree ("run_id","company_id");--> statement-breakpoint
CREATE INDEX "run_candidate_status_idx" ON "run_candidates" USING btree ("run_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "suppression_uniq" ON "suppressions" USING btree ("identifier_type","identifier_value");--> statement-breakpoint
CREATE INDEX "tech_company_idx" ON "technology_evidence" USING btree ("company_id");