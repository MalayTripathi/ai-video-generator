CREATE TABLE IF NOT EXISTS "public"."usage" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "project_id" "uuid" NOT NULL,
    "provider" "text" NOT NULL,
    "kind" "text" NOT NULL,
    "input_units" numeric DEFAULT 0 NOT NULL,
    "output_units" numeric DEFAULT 0 NOT NULL,
    "cache_creation_units" numeric DEFAULT 0 NOT NULL,
    "cache_read_units" numeric DEFAULT 0 NOT NULL,
    "estimated_cost" numeric,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);

ALTER TABLE "public"."usage" OWNER TO "postgres";

ALTER TABLE ONLY "public"."usage"
    ADD CONSTRAINT "usage_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."usage"
    ADD CONSTRAINT "usage_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE CASCADE;

CREATE INDEX "usage_project_id_created_at_idx" ON "public"."usage" USING "btree" ("project_id", "created_at");

ALTER TABLE "public"."usage" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users manage usage in their own projects" ON "public"."usage" USING ((EXISTS ( SELECT 1
   FROM "public"."projects"
  WHERE (("projects"."id" = "usage"."project_id") AND ("projects"."user_id" = "auth"."uid"())))));

GRANT ALL ON TABLE "public"."usage" TO "anon";
GRANT ALL ON TABLE "public"."usage" TO "authenticated";
GRANT ALL ON TABLE "public"."usage" TO "service_role";
