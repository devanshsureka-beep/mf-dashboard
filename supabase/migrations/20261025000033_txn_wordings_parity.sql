-- =============================================================================
-- txn_effective_type(): the words that keep a stored purchase from counting as
-- a SIP instalment now match the app exactly (NOT_SIP_CONTEXT in
-- lib/parsers/cas.ts): "Div. Reinvestment SIP" stays a purchase (0032 read it
-- as SIP, so SIP progress could count a dividend), plus "units extinguished"
-- and "amalgamation". A DB test checks the app and this function agree.
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
     and coalesce(p_description, '') !~* '(switch|lateral|\ystp\y|transfer|\yswp\y|withdraw|redemp|redeem|repurchase|units extinguished|dividend|idcw|\ydiv\y|merger|amalgamation|bonus)'
    then 'SIP'
    when p_type = 'SWITCH_IN' and coalesce(p_units, 0) < 0
     and coalesce(p_description, '') ~* '(switch[\s-]*(over\s*)?out|lateral (shift )?out|stp[\s-]*out|transfer[\s-]*(plan[\s-]*)?out|\ysys(tematic|t)?\.?\s*transfer.{0,20}?\yout\y)'
    then 'SWITCH_OUT'
    else p_type
  end
$$;
