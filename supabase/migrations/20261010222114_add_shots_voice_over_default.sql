-- Lets a batched shots upsert (one statement, keyed on id) carry only the identity columns
-- and the column it changes: Postgres checks NOT NULL on the proposed insert row before it
-- resolves the conflict, so a required voice_over would otherwise have to be sent - and
-- would overwrite a concurrent edit. Every insert path still sets voice_over explicitly.
alter table "public"."shots" alter column "voice_over" set default '';
