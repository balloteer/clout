begin;

-- The application signs uploads only into a private quarantine bucket. It validates
-- MP4 bytes before copying them to public playback; wallet sessions are NOT Supabase Auth.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('clout-upload-staging', 'clout-upload-staging', false, 52428800, array['video/mp4']),
  ('clout-videos', 'clout-videos', true, 52428800, array['video/mp4'])
on conflict (id) do nothing;

do $$
begin
  if (select count(*) from storage.buckets where
      (id = 'clout-upload-staging' and public = false or id = 'clout-videos' and public = true)
      and file_size_limit = 52428800 and allowed_mime_types = array['video/mp4']) <> 2 then
    raise exception 'Existing Clout Storage buckets have incompatible privacy or file restrictions; review before migrating';
  end if;
  if not exists (select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='storage' and c.relname='objects' and c.relrowsecurity) then
    raise exception 'Storage object row level security must already be enabled';
  end if;
end $$;

-- A restrictive policy also closes an existing broad permissive policy. Bucket public
-- playback is served by Storage; only server service credentials may mutate these objects.
create policy clout_server_only_video_objects on storage.objects
as restrictive for all to anon, authenticated
using (bucket_id not in ('clout-upload-staging', 'clout-videos'))
with check (bucket_id not in ('clout-upload-staging', 'clout-videos'));

commit;
