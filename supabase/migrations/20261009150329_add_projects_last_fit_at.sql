-- When Fit to voiceover last wrote this project's shot lengths (auto or by hand).
alter table "public"."projects"
    add column "last_fit_at" timestamptz;
