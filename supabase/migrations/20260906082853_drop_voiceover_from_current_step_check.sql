-- The pipeline is 7 steps, not 8: voiceover is no longer a step of its own, having
-- merged into storyboard (which now owns generate_image, voiceover and background_music).
-- 'voiceover' therefore leaves projects.current_step's vocabulary.
--
-- The DO block mirrors 20260901125544_add_current_step_check.sql's 'script' pattern:
-- verify no row still holds the departing value and fail loudly rather than silently.
-- Nothing has ever written current_step past 'workbench' (advanceStep has no callers),
-- so this is expected to be zero.
do $$
declare
  stray_count int;
begin
  select count(*) into stray_count from public.projects where current_step = 'voiceover';
  if stray_count > 0 then
    raise exception 'drop_voiceover_from_current_step_check aborted: % row(s) still hold ''voiceover''', stray_count;
  end if;
end $$;

alter table "public"."projects" drop constraint "projects_current_step_check";

alter table "public"."projects"
    add constraint "projects_current_step_check"
    check ("current_step" in (
      'workbench', 'image_prompts', 'storyboard',
      'video_prompts', 'generation', 'assembly'
    ));
