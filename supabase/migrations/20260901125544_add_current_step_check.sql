-- projects.current_step has been app-code-enforced only since the original schema
-- (see the comment in 20260831095602_drop_jobs_create_generations.sql). This adds
-- its first-ever CHECK constraint, matching aspect_ratio/duration_target/video_type.
-- 'script' is excluded - Phase 2 already backfilled every row and changed the column
-- default away from it (20260901104929_current_step_default_workbench.sql). This
-- block verifies that assumption and fails loudly rather than silently if it's wrong.
do $$
declare
  stray_count int;
begin
  select count(*) into stray_count from public.projects where current_step = 'script';
  if stray_count > 0 then
    raise exception 'add_current_step_check aborted: % row(s) still hold ''script''', stray_count;
  end if;
end $$;

alter table "public"."projects"
    add constraint "projects_current_step_check"
    check ("current_step" in (
      'workbench', 'voiceover', 'image_prompts', 'storyboard',
      'video_prompts', 'generation', 'assembly'
    ));
