-- =============================================================================
-- More RTA wordings, read where transactions are used (stored rows are immutable).
-- * SIP instalments: "S.I.P.", "ISIP" / "XSIP" / "Micro SIP" / "NFO SIP",
--   "Sys Inv", "Syst. Purchase", "Systematic Deposit", "Instalment No",
--   "Auto Debit Purchase", "ECS Purchase" (besides the 0030 wordings).
-- * "Systematic Transfer Plan Out" was stored as a switch IN by an older
--   reader: with units going out it counts as SWITCH_OUT.
-- Mirrors SIP_TEXT / effectiveTxnType() in lib/parsers/cas.ts; a DB test
-- checks both give the same answer for every wording.
-- =============================================================================

create or replace function public.txn_effective_type(p_type text, p_description text, p_units numeric)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when coalesce(p_units, 0) <> 0
     and p_type in ('PURCHASE', 'SIP', 'STAMP_DUTY', 'STT', 'TDS', 'OTHER')
     and coalesce(p_description, '') ~* '(\ys\.?i\.?p\y|\ysip(purchase|instal)|\y(x|i|micro|nfo\s*)sip\y|\ysys(tematic|t)?\.?\s*(invest|inv\y|purchase|purch|instal|deposit)|purchase[^a-z0-9]*(ongoing\s*)?(sys|sip)|(purchase|investment)[^a-z0-9]*instal|instal+ment\s*(no|#)|auto[\s-]*debit\s*purchase|ecs\s*purchase)'
     and coalesce(p_description, '') !~* '(cancel|revers|reject|invalid|refund)'
     and coalesce(p_description, '') !~* '(switch|lateral|\ystp\y|transfer|\yswp\y|withdraw|redemp|redeem|repurchase|dividend|idcw|merger|bonus)'
    then 'SIP'
    when p_type = 'SWITCH_IN' and coalesce(p_units, 0) < 0
     and coalesce(p_description, '') ~* '(switch[\s-]*(over\s*)?out|lateral (shift )?out|stp[\s-]*out|transfer[\s-]*(plan[\s-]*)?out|\ysys(tematic|t)?\.?\s*transfer.{0,20}?\yout\y)'
    then 'SWITCH_OUT'
    else p_type
  end
$$;

comment on function public.txn_effective_type(text, text, numeric) is
  'The type a CAS transaction is used as: SIP instalments stored by an older reader as PURCHASE (or a tax line with units) count as SIP; an STP out stored as SWITCH_IN counts as SWITCH_OUT. Mirrors effectiveTxnType() in lib/parsers/cas.ts.';
