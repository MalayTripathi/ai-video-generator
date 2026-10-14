-- The scene's shot slots: one model-valid length per shot, in order, set by code when the
-- outline is written (never by the model). Each chunk request asks for its slots and each
-- written shot takes the next one. Null on scenes planned before slots existed.
alter table "public"."scenes"
    add column "slot_seconds" numeric[];
