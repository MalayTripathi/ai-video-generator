ALTER TABLE "public"."projects"
    ALTER COLUMN "title" DROP NOT NULL,
    ALTER COLUMN "title" DROP DEFAULT;
