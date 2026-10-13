begin;

-- Keep one immutable faucet campaign and its recovery history across UTC dates.
alter table private.reward_claims add column claim_day date;
update private.campaigns set data = data || '{"period":"utc-day"}'::jsonb
where id like 'faucet\_%' escape '\' and data->>'authority' is not null;
update private.reward_claims r
set claim_day = (r.created_at at time zone 'UTC')::date,
    data = r.data || jsonb_build_object('day', to_char(r.created_at at time zone 'UTC', 'YYYY-MM-DD'))
from private.campaigns c where c.id = r.campaign_id and c.data->>'period' = 'utc-day';
alter table private.reward_claims drop constraint reward_claims_campaign_id_sgt_mint_key;
alter table private.reward_claims drop constraint reward_claims_campaign_id_wallet_key;
create unique index reward_claims_once_sgt_idx on private.reward_claims (campaign_id, sgt_mint) where claim_day is null;
create unique index reward_claims_once_wallet_idx on private.reward_claims (campaign_id, wallet) where claim_day is null;
create unique index reward_claims_daily_wallet_idx on private.reward_claims (campaign_id, wallet, claim_day) where claim_day is not null;
create index reward_claims_daily_count_idx on private.reward_claims (campaign_id, claim_day);
create index reward_claims_pending_idx on private.reward_claims (campaign_id, id)
where data->>'state' not in ('finalized', 'expired') and not (data->>'state' = 'failed' and coalesce((data->>'attemptCount')::int, 0) >= 3);
alter table private.reward_claims add constraint reward_claim_day_matches check (
  (claim_day is null and not data ? 'day') or
  (claim_day is not null and data->>'day' is not null and data->>'day' = to_char(claim_day, 'YYYY-MM-DD'))
);

-- Immutable baseline + monotonically reserved units protects the absolute supply ceiling,
-- including ambiguous/expired payments and simultaneous workers. Finalization never refunds it.
create table private.faucet_budgets (
  campaign_id text primary key references private.campaigns(id),
  baseline_supply numeric(20,0) not null check (baseline_supply >= 0),
  allocated_units numeric(20,0) not null check (allocated_units >= 0),
  max_supply numeric(20,0) not null check (max_supply > 0 and max_supply <= 18446744073709551615),
  check (baseline_supply + allocated_units <= max_supply)
);
alter table private.faucet_budgets enable row level security;
revoke all on private.faucet_budgets from public, anon, authenticated;

create function private.reserve_daily_faucet(p_campaign text, p_wallet text, p_id uuid)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  campaign jsonb;
  existing jsonb;
  budget private.faucet_budgets%rowtype;
  claim jsonb;
  claim_date date;
  claim_time timestamptz;
  total bigint;
  amount numeric;
begin
  perform pg_advisory_xact_lock(hashtext('clout:campaign-registration'));
  select data into campaign from private.campaigns where id = p_campaign for update;
  if campaign is null or campaign->>'period' is distinct from 'utc-day'
     or campaign->>'enabled' is distinct from 'true' or campaign->>'active' is distinct from 'true' then
    raise exception 'FAUCET_DISABLED';
  end if;
  -- Read the real clock only after the reservation lock, including waits across midnight.
  claim_time := clock_timestamp();
  claim_date := (claim_time at time zone 'UTC')::date;
  select data into existing from private.reward_claims
    where campaign_id = p_campaign and wallet = p_wallet and (
      claim_day = claim_date or
      (data->>'state' <> 'finalized' and not (data->>'state' = 'failed' and coalesce((data->>'attemptCount')::int, 0) >= 3))
    ) order by created_at limit 1;
  if existing is not null then return existing; end if;
  select count(*) into total from private.reward_claims where campaign_id = p_campaign and claim_day = claim_date;
  if total >= (campaign->>'maxClaims')::integer then raise exception 'FAUCET_DAILY_CAP'; end if;
  select * into budget from private.faucet_budgets where campaign_id = p_campaign for update;
  amount := (campaign->>'amount')::numeric;
  if budget.campaign_id is null or budget.max_supply <> (campaign->>'maxSupply')::numeric
    or budget.baseline_supply + budget.allocated_units + amount > budget.max_supply then
    raise exception 'FAUCET_SUPPLY_CAP';
  end if;
  claim := jsonb_build_object(
    'id', p_id, 'campaignId', p_campaign, 'sgtMint', 'faucet:' || p_wallet,
    'wallet', p_wallet, 'amount', campaign->>'amount', 'state', 'reserved',
    'signature', null, 'signedTransaction', null, 'lastValidBlockHeight', null,
    'createdAt', to_char(claim_time at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'day', to_char(claim_date, 'YYYY-MM-DD')
  );
  update private.faucet_budgets set allocated_units = allocated_units + amount where campaign_id = p_campaign;
  insert into private.reward_claims (id, campaign_id, sgt_mint, wallet, data, created_at, claim_day)
    values (p_id, p_campaign, 'faucet:' || p_wallet, p_wallet, claim, claim_time, claim_date);
  return claim;
end;
$$;
revoke all on function private.reserve_daily_faucet(text, text, uuid) from public, anon, authenticated;

commit;
