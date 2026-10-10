-- When a person last retimed a shot by hand on the Storyboard. Later than last_fit_at
-- means a voiceover regenerate asks before refitting instead of refitting silently.
alter table "public"."projects"
    add column "last_manual_retime_at" timestamptz;
