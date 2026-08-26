create policy "users can read own artifacts"
on storage.objects for select
to authenticated
using (
  bucket_id = 'artifacts'
  and (storage.foldername(name))[1] = auth.uid()::text
);

create policy "users can upload own artifacts"
on storage.objects for insert
to authenticated
with check (
  bucket_id = 'artifacts'
  and (storage.foldername(name))[1] = auth.uid()::text
);

create policy "users can delete own artifacts"
on storage.objects for delete
to authenticated
using (
  bucket_id = 'artifacts'
  and (storage.foldername(name))[1] = auth.uid()::text
);

ALTER TABLE "public"."projects" ADD COLUMN "voice_id" "text";
ALTER TABLE "public"."projects" ADD COLUMN "language_code" "text";
ALTER TABLE "public"."projects" ADD COLUMN "tts_model" "text";
