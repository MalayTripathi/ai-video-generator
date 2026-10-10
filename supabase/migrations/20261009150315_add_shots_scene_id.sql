-- The scene a shot belongs to. Nullable and SET NULL: deleting a scene never deletes its
-- shots, and a shot written before scenes existed has none.
alter table "public"."shots"
    add column "scene_id" uuid references "public"."scenes"("id") on delete set null;

create index "shots_scene_id_idx" on "public"."shots" using btree ("scene_id");
