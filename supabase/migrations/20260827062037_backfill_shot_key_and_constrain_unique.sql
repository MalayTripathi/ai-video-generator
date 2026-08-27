-- shot_key drifted from ordinal values (s001, s002...) as shots are
-- inserted/deleted out of order. Replace with stable random keys so a
-- shot's identity never depends on its position.
--
-- One-time backfill: existing shots get a random 5-char key from the same
-- vowel-free alphabet the app uses going forward for new rows
-- (src/lib/shot-key.ts). This SQL never runs again after this migration -
-- all future rows get their key from TypeScript at insert time, with
-- retry-on-collision there.
do $$
declare
  alphabet text := '23456789bcdfghjkmnpqrstvwxz';
  r record;
  candidate text;
  attempts int;
begin
  for r in select id, project_id from public.shots where shot_key is null loop
    attempts := 0;
    loop
      candidate := '';
      for i in 1..5 loop
        candidate := candidate || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
      end loop;
      attempts := attempts + 1;
      exit when not exists (
        select 1 from public.shots
        where project_id = r.project_id and shot_key = candidate and id <> r.id
      ) or attempts > 20;
    end loop;
    update public.shots set shot_key = candidate where id = r.id;
  end loop;
end $$;

alter table "public"."shots" alter column "shot_key" set not null;

alter table "public"."shots"
    add constraint "shots_project_id_shot_key_key" unique ("project_id", "shot_key");
