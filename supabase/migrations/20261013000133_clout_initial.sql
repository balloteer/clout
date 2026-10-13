begin;

-- Opaque API sessions are not Supabase Auth JWTs. Only the API may write social data.
-- The private schema must not be included in Supabase's exposed schemas.
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create table public.profiles (
  wallet text primary key,
  data jsonb not null,
  created_at timestamptz not null default now(),
  constraint profile_wallet_matches check (data->>'wallet' = wallet)
);
create table public.posts (
  id text primary key,
  creator_wallet text not null references public.profiles(wallet),
  stream_uid text unique,
  status text not null check (status in ('processing', 'ready', 'failed')),
  data jsonb not null,
  created_at timestamptz not null default now(),
  constraint post_identity_matches check (data->>'id' = id and data->>'creatorWallet' = creator_wallet and data->>'status' = status)
);
create index posts_ready_created_idx on public.posts (created_at desc) where status = 'ready';
create index posts_creator_idx on public.posts (creator_wallet, created_at desc);
create table public.comments (
  id uuid primary key,
  post_id text not null references public.posts(id),
  wallet text not null references public.profiles(wallet),
  data jsonb not null,
  created_at timestamptz not null default now(),
  constraint comment_identity_matches check (data->>'wallet' = wallet and data->>'postId' = post_id and length(data->>'body') between 1 and 500)
);
create index comments_post_idx on public.comments (post_id, created_at desc);
create index comments_wallet_idx on public.comments (wallet);
create table public.likes (
  post_id text not null references public.posts(id),
  wallet text not null references public.profiles(wallet),
  created_at timestamptz not null default now(),
  primary key (post_id, wallet)
);
create index likes_wallet_idx on public.likes (wallet);
create table public.follows (
  wallet text not null references public.profiles(wallet),
  target_wallet text not null references public.profiles(wallet),
  created_at timestamptz not null default now(),
  primary key (wallet, target_wallet),
  check (wallet <> target_wallet)
);
create index follows_target_idx on public.follows (target_wallet);

alter table public.profiles enable row level security;
alter table public.posts enable row level security;
alter table public.comments enable row level security;
alter table public.likes enable row level security;
alter table public.follows enable row level security;
revoke all on public.profiles, public.posts, public.comments, public.likes, public.follows from anon, authenticated;
grant select on public.profiles, public.posts, public.comments to anon, authenticated;
create policy profiles_public_read on public.profiles for select to anon, authenticated using (true);
create policy posts_ready_read on public.posts for select to anon, authenticated using (status = 'ready');
create policy comments_ready_read on public.comments for select to anon, authenticated using (
  exists (select 1 from public.posts where posts.id = comments.post_id and posts.status = 'ready')
);

create table private.wallet_challenges (
  id text primary key check (length(id) = 48),
  address text not null,
  message text not null,
  expires_at timestamptz not null
);
create index wallet_challenges_expiry_idx on private.wallet_challenges (expires_at);
create table private.wallet_sessions (
  token_hash text primary key check (length(token_hash) = 64),
  wallet text not null,
  expires_at timestamptz not null
);
create index wallet_sessions_expiry_idx on private.wallet_sessions (expires_at);
create index wallet_sessions_wallet_idx on private.wallet_sessions (wallet);
create table private.campaigns (
  id text primary key,
  data jsonb not null,
  constraint campaign_bounds check (
    data->>'symbol' = 'SKR' and (data->>'maxClaims')::integer between 1 and 10000
    and (data->>'amount')::numeric > 0 and (data->>'amount')::numeric <= 18446744073709551615
  )
);
create table private.reward_claims (
  id uuid primary key,
  campaign_id text not null references private.campaigns(id),
  sgt_mint text not null,
  wallet text not null,
  data jsonb not null,
  created_at timestamptz not null default now(),
  unique (campaign_id, sgt_mint),
  unique (campaign_id, wallet)
);
create unique index reward_claims_signature_idx on private.reward_claims ((data->>'signature')) where data->>'signature' is not null;
create index reward_claims_wallet_idx on private.reward_claims (wallet);
create table private.trade_quotes (
  id uuid primary key,
  data jsonb not null,
  expires_at timestamptz not null
);
create index trade_quotes_expiry_idx on private.trade_quotes (expires_at);
create table private.transaction_intents (
  id uuid primary key,
  wallet text not null,
  post_id text references public.posts(id),
  signature text unique,
  state text not null check (state in ('prepared', 'pending', 'confirmed', 'finalized', 'expired', 'failed')),
  data jsonb not null,
  created_at timestamptz not null default now()
);
create index transaction_intents_pending_idx on private.transaction_intents (created_at) where state in ('prepared', 'pending');
create index transaction_intents_wallet_idx on private.transaction_intents (wallet);
create index transaction_intents_post_idx on private.transaction_intents (post_id);
create unique index transaction_intents_one_launch_idx on private.transaction_intents (post_id)
  where data->>'kind' = 'launch' and state not in ('failed', 'expired');
create table private.indexed_events (
  signature text not null,
  instruction_path text not null,
  slot bigint not null check (slot >= 0),
  wallet text not null,
  post_id text not null references public.posts(id),
  finality text not null check (finality in ('confirmed', 'finalized')),
  data jsonb not null,
  primary key (signature, instruction_path)
);
create index indexed_events_wallet_idx on private.indexed_events (wallet, slot desc);
create index indexed_events_post_idx on private.indexed_events (post_id, slot);
create table private.indexer_checkpoints (
  source text primary key,
  signature text not null,
  slot bigint not null check (slot >= 0)
);

-- No client policy on operational tables; even accidental schema exposure fails closed.
alter table private.wallet_challenges enable row level security;
alter table private.wallet_sessions enable row level security;
alter table private.campaigns enable row level security;
alter table private.reward_claims enable row level security;
alter table private.trade_quotes enable row level security;
alter table private.transaction_intents enable row level security;
alter table private.indexed_events enable row level security;
alter table private.indexer_checkpoints enable row level security;
revoke all on all tables in schema private from public, anon, authenticated;
revoke all on all functions in schema private from public, anon, authenticated;

commit;
