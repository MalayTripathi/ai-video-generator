-- At most one live style element per project. Soft-deleted rows (deleted_at set) are
-- outside the index, so a deleted style never blocks its replacement.
create unique index "elements_one_live_style_idx"
    on "public"."elements" ("project_id")
    where "type" = 'style' and "deleted_at" is null;
