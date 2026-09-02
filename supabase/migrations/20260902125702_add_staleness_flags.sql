-- Downstream staleness flags. These columns get no writers yet - the C3 edit
-- action (a later slice) is the only thing that will ever set them. Created
-- now because it's the only writer that will ever exist for them; adding
-- them later would mean reaching back into a shipped slice to add a
-- scattered write, the pattern that previously broke furthest_step.
--
-- Staleness is set by user edits only, never by a pipeline. Step 3's
-- voiceover pipeline writes duration_sec back onto every shot where
-- duration_locked = false. If the voiceover pipeline also set
-- voiceover_stale, it would invalidate its own output on every successful
-- run - the user regenerates, the pipeline writes durations again, the flag
-- sets again, unbounded, and every cycle is a paid ElevenLabs call.
-- runVoiceoverPipeline must never write voiceover_stale.

alter table "public"."shots"
    add column "image_prompt_stale" boolean not null default false,
    add column "video_prompt_stale" boolean not null default false;

alter table "public"."projects"
    add column "voiceover_stale" boolean not null default false;
