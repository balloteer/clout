begin;

-- Durable fair scheduling prevents old pending uploads from starving newer rows
-- when Vercel starts a fresh container for each recovery invocation.
create table private.upload_recovery_checks (
  post_id text primary key references public.posts(id) on delete cascade,
  checked_at timestamptz not null
);
create index upload_recovery_checks_checked_idx
  on private.upload_recovery_checks (checked_at asc, post_id asc);

alter table private.upload_recovery_checks enable row level security;
revoke all on private.upload_recovery_checks from public, anon, authenticated;

commit;
