-- Who made an element and whether a person has since changed it - what the end-of-run
-- cleanup of unused elements reads, so it never removes a person's work. 'model' is the
-- pipeline (outline, chunks); 'user' is the Assets tab. user_edited_at is set on a rename,
-- a description change, or a person binding the element to a shot. Every existing row is
-- 'model' with no edit time (no user has created elements).
alter table "public"."elements"
    add column "origin" text not null default 'model',
    add column "user_edited_at" timestamptz,
    add constraint "elements_origin_check" check ("origin" in ('model', 'user'));
