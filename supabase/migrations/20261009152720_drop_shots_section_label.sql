-- Section labels are now scenes (backfilled from consecutive labels into public.scenes and
-- shots.scene_id); every reader uses the scene title. The column goes.
alter table "public"."shots"
    drop column "section_label";
