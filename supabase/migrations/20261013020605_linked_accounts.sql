begin;
create table private.link_oauth (
  hash text primary key, wallet text not null references public.profiles(wallet),
  expires_at timestamptz not null, data jsonb not null
);
create index link_oauth_expiry on private.link_oauth(expires_at);
create index link_oauth_wallet on private.link_oauth(wallet);
create table private.linked_accounts (
  id uuid primary key, wallet text not null references public.profiles(wallet),
  provider text not null check(provider in ('x','fomo')), provider_user_id text not null,
  data jsonb not null, created_at timestamptz not null default now(), unique(provider,provider_user_id)
);
create index linked_accounts_wallet on private.linked_accounts(wallet);
-- The database also enforces the combined-provider limit under a wallet lock.
create function private.enforce_link_limit() returns trigger language plpgsql security invoker set search_path='' as $$
begin
  perform pg_advisory_xact_lock(hashtext('clout:links:' || new.wallet));
  if tg_op = 'UPDATE' and new.wallet <> old.wallet then raise exception 'Linked account owner is immutable'; end if;
  if (select count(*) from private.linked_accounts where wallet=new.wallet and id<>new.id) >= 3 then
    raise exception 'A wallet can link at most three accounts' using errcode='23514';
  end if;
  return new;
end $$;
create trigger linked_accounts_limit before insert or update of wallet on private.linked_accounts for each row execute function private.enforce_link_limit();
create table private.link_imports (
  id uuid primary key, account_id uuid not null, wallet text not null references public.profiles(wallet),
  provider text not null check(provider in ('x','fomo')), source_id text not null, post_id uuid not null,
  data jsonb not null, created_at timestamptz not null default now(), unique(wallet,provider,source_id)
);
create index link_imports_account on private.link_imports(account_id);
create unique index link_imports_stream on private.link_imports((data->>'streamUid')) where data->>'streamUid' is not null;
alter table private.link_oauth enable row level security;
alter table private.linked_accounts enable row level security;
alter table private.link_imports enable row level security;
revoke all on private.link_oauth, private.linked_accounts, private.link_imports from public, anon, authenticated;
revoke all on function private.enforce_link_limit() from public, anon, authenticated;
commit;
