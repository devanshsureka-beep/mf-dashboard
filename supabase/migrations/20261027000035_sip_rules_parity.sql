-- =============================================================================
-- One rule for transaction types and SIP instalments, in the database and the app.
--
-- 1) txn_classify(): the same reading as classifyTransaction() in
--    lib/parsers/cas.ts, and txn_effective_type() now matches
--    effectiveTxnType(): rows an older reader stored as STT / TDS /
--    STAMP_DUTY / OTHER although they moved units ("Redemption less STT",
--    "Purchase") are read again from their description, as the app does.
--    "Reverse ..." and "Rejects" are never a new trade (as cancellations).
-- 2) v_sip_instalments: the transactions that are SIP instalments, the rule of
--    instalments() in lib/domain/sip-status.ts: explicit SIP rows, plus runs of
--    3+ same-amount (to ₹50) purchases 20-40 days apart in one fund and folio;
--    an instalment bounced by a rejection / reversal of the same amount within
--    15 days is not one.
-- 3) v_sip_item_progress (as 20261023000031) counts those: a SIP the CAS calls
--    "Purchase" showed ₹0 invested while the SIP card said it runs, and a
--    bounced instalment counted as invested. Same columns as before.
-- =============================================================================

create or replace function public.txn_classify(p_description text, p_units numeric)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  d text := lower(coalesce(p_description, ''));
  rest text;
begin
  -- Reversals, cancellations, rejections, invalid entries and refunds are never a new trade.
  if d ~ '(cancel|revers(e|al|ed)|reject|invalid|refund)' then return 'OTHER'; end if;
  if d ~ '(stamp duty|\ystt\y|\ytds\y)' then
    -- A tax line moves no units; a row with units is the trade itself, its description mentions the tax.
    if coalesce(p_units, 0) = 0 then
      return case when d ~ 'stamp duty' then 'STAMP_DUTY' when d ~ '\ystt\y' then 'STT' else 'TDS' end;
    end if;
    rest := public.txn_classify(regexp_replace(d, 'stamp duty|\ystt\y|\ytds\y', ' ', 'g'), p_units);
    if rest <> 'OTHER' then return rest; end if;
    return case when p_units < 0 then 'REDEMPTION' else 'PURCHASE' end;
  end if;
  if d ~ '(switch[\s-]*(over\s*)?out|lateral (shift )?out|stp[\s-]*out|transfer[\s-]*(plan[\s-]*)?out|\ysys(tematic|t)?\.?\s*transfer.{0,20}?\yout\y)' then return 'SWITCH_OUT'; end if;
  if d ~ '(switch[\s-]*(over\s*)?in|lateral (shift )?in|stp[\s-]*in|transfer[\s-]*in|\ysys(tematic|t)?\.?\s*transfer)' then return 'SWITCH_IN'; end if;
  if d ~ '(merger|amalgamation)' then return 'MERGER'; end if;
  if d ~ '(redemption|redeem|repurchase|\yswp\y|\ysys(tematic|t)?\.?\s*withdraw|units extinguished)' then return 'REDEMPTION'; end if;
  if d ~ '(dividend|idcw|\ydiv\y).*(reinv)' then return 'DIVIDEND_REINVESTMENT'; end if;
  if d ~ '(dividend|idcw)' then return 'DIVIDEND_PAYOUT'; end if;
  if d ~ 'bonus' then return 'BONUS'; end if;
  if d ~ '(\ys\.?i\.?p\y|\ysip(purchase|instal)|\y(x|i|micro|nfo\s*)sip\y|\ysys(tematic|t)?\.?\s*(invest|inv\y|purchase|purch|instal|deposit)|purchase[^a-z0-9]*(ongoing\s*)?(sys|sip)|(purchase|investment)[^a-z0-9]*instal|instal+ment\s*(no|#)|auto[\s-]*debit\s*purchase|ecs\s*purchase)' then return 'SIP'; end if;
  if d ~ '(purchase|nfo|investment|new fund offer|subscription|initial allotment)' then return 'PURCHASE'; end if;
  return 'OTHER';
end
$$;

create or replace function public.txn_effective_type(p_type text, p_description text, p_units numeric)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_description is null or coalesce(p_units, 0) = 0 then p_type
    -- A SIP instalment an older reader stored as a plain purchase.
    when p_type = 'PURCHASE' then
      case when public.txn_classify(p_description, p_units) = 'SIP'
            and p_description !~* '(switch|lateral|\ystp\y|transfer|\yswp\y|withdraw|redemp|redeem|repurchase|units extinguished|dividend|idcw|\ydiv\y|merger|amalgamation|bonus)'
           then 'SIP' else p_type end
    -- "Systematic Transfer Plan Out" an older reader stored as a switch in.
    when p_type = 'SWITCH_IN' then
      case when p_units < 0 and p_description ~* '(switch[\s-]*(over\s*)?out|lateral (shift )?out|stp[\s-]*out|transfer[\s-]*(plan[\s-]*)?out|\ysys(tematic|t)?\.?\s*transfer.{0,20}?\yout\y)'
           then 'SWITCH_OUT' else p_type end
    -- A tax or unknown type that moved units: read again from the description.
    when p_type in ('STT', 'TDS', 'STAMP_DUTY', 'OTHER') then public.txn_classify(p_description, p_units)
    else p_type
  end
$$;

create or replace view public.v_sip_instalments
with (security_invoker = true) as
with tx as (
  select t.id, t.client_id, t.security_id, t.transaction_date as d, t.amount, t.units, t.description,
         public.txn_effective_type(t.transaction_type, t.description, t.units) as et,
         -- The fund and folio a SIP runs in (the part of a folio after "/" is a check digit).
         coalesce(t.isin, sm.isin, lower(t.scheme_name)) || '|' || lower(regexp_replace(split_part(coalesce(t.folio_number, ''), '/', 1), '[^0-9a-zA-Z]', '', 'g')) as fund,
         round(abs(t.amount) / 50) * 50 as amt
  from public.portfolio_transactions t
  left join public.security_master sm on sm.id = t.security_id
), buys as (
  select * from tx where amount > 0 and units > 0 and et in ('SIP', 'PURCHASE')
), seq as (
  select b.*, b.d - lag(b.d) over (partition by b.client_id, b.fund, b.amt order by b.d) as gap from buys b where b.et = 'PURCHASE'
), runs as (
  select s.*, sum(case when s.gap is null or s.gap < 20 or s.gap > 40 then 1 else 0 end)
              over (partition by s.client_id, s.fund, s.amt order by s.d rows unbounded preceding) as run_no
  from seq s
), sized as (
  select r.*, count(*) over (partition by r.client_id, r.fund, r.amt, r.run_no) as run_len from runs r
), bounced as (
  -- A rejection / reversal / bounce of the same amount within 15 days takes back the latest instalment before it.
  select distinct on (x.id) b.id as buy_id
  from tx x
  join buys b on b.client_id = x.client_id and b.fund = x.fund and b.amt = x.amt
   and b.d between x.d - 15 and x.d
  where (coalesce(x.units, 0) < 0 or coalesce(x.amount, 0) < 0)
    and coalesce(x.description, '') ~* '(reject|revers|bounce|return)'
  order by x.id, b.d desc
)
select b.id as transaction_id, b.client_id, b.security_id, b.d as transaction_date, abs(b.amount) as amount, b.units
from buys b
where (b.et = 'SIP' or b.id in (select id from sized where run_len >= 3))
  and b.id not in (select buy_id from bounced);

comment on view public.v_sip_instalments is
  'Transactions that are SIP instalments: explicit SIP rows plus monthly runs (3+, same amount to ₹50, 20-40 days apart) of plain purchases in one fund and folio, less instalments bounced by a same-amount rejection within 15 days. Same rule as instalments() in lib/domain/sip-status.ts.';

create or replace view public.v_sip_item_progress
with (security_invoker = true) as
-- As 20261023000031 (an instalment counted once across lines, lines from the report date), the
-- instalments now from v_sip_instalments.
with lines as (
  select s.*, p.status as plan_status,
         -- From the report date when that is earlier than the advice / approval:
         -- clients often start or change a SIP on the report before the plan is approved.
         least(coalesce((s.advised_at at time zone 'Asia/Kolkata')::date,
                        (p.approved_at at time zone 'Asia/Kolkata')::date,
                        (s.created_at at time zone 'Asia/Kolkata')::date),
               p.plan_date) as since
  from public.sip_plan_items s
  join public.advisory_plans p on p.id = s.plan_id
), txns as (
  select i.transaction_id as id, i.client_id, i.security_id, i.transaction_date, i.amount
  from public.v_sip_instalments i
  where i.security_id is not null
), owned as (
  select distinct on (l.plan_id, t.id) l.id as line_id, t.amount, t.transaction_date
  from txns t
  join lines l on l.client_id = t.client_id and l.security_id = t.security_id
              and l.action in ('START', 'CHANGE') and l.status <> 'CANCELLED' and l.since <= t.transaction_date
              -- A changed SIP counts only instalments at the new amount (not the old SIP still running).
              and (l.action = 'START' or l.new_amount is null
                   or abs(t.amount - l.new_amount) <= greatest(50, l.new_amount * 0.05))
  order by l.plan_id, t.id, l.since desc, l.created_at desc
), per_line as (
  select line_id, sum(amount) as amount, count(*) as instalments, max(transaction_date) as last_date
  from owned group by line_id
)
select
  l.id as sip_item_id,
  l.plan_id,
  l.client_id,
  l.plan_status,
  l.security_id,
  l.scheme_name,
  l.action,
  l.status as item_status,
  l.frequency,
  l.old_amount,
  l.new_amount,
  (case when l.action = 'STOP' then 0 else coalesce(l.new_amount, 0) end)::numeric(18,2) as monthly_amount,
  l.since as since_date,
  coalesce(pl.amount, 0)::numeric(18,2) as invested_amount,
  coalesce(pl.instalments, 0) as instalments,
  pl.last_date as last_instalment_date
from lines l
left join per_line pl on pl.line_id = l.id;

grant select on public.v_sip_instalments to authenticated;
