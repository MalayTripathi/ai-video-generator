ALTER TABLE "public"."projects" ALTER COLUMN "current_step" SET DEFAULT 'workbench';

UPDATE "public"."projects" SET "current_step" = 'workbench' WHERE "current_step" = 'script';
