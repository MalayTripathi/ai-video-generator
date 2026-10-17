-- Projects are deleted only through the server route (service role), which checks for live
-- work and open holds first. No client may delete a projects row directly.
drop policy "users can delete their own projects" on "public"."projects";
