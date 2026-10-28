-- =============================================================================
-- Give the app's login user ownership of everything the app uses.
--
-- Why: on Supabase the `postgres` user owned the tables, ran the migrations and the app's server
-- work (sign-in, sessions, admin actions), and the row-level-security helper functions
-- (SECURITY DEFINER) ran as that same owner. On Cloud SQL the same must hold for the app's login
-- user, or those helpers read the tables WITH row-level security and everyone sees an empty app.
-- Use this when the database was migrated by another user (e.g. `postgres`). Alternative: grant
-- the app user everything instead, but ownership is the closest match to how it ran before.
--
-- Run as the user that owns the objects now (or an admin), once. Idempotent.
-- Check afterwards with: DATABASE_URL=... npm run db:check
-- =============================================================================
do $$
declare
  app_user text := 'mf_app_user';   -- EDIT if the app connects as another user
  r record;
begin
  if not exists (select 1 from pg_roles where rolname = app_user) then
    raise exception 'Role % does not exist', app_user;
  end if;
  -- The user running this must be allowed to hand objects to the app user.
  execute format('grant %I to current_user', app_user);

  for r in select quote_ident(nspname) as s from pg_namespace where nspname in ('public', 'app', 'auth', 'storage', 'supabase_migrations') loop
    execute format('alter schema %s owner to %I', r.s, app_user);
  end loop;

  for r in
    select quote_ident(n.nspname) || '.' || quote_ident(c.relname) as obj,
           case c.relkind when 'S' then 'sequence' when 'v' then 'view' when 'm' then 'materialized view' else 'table' end as kind
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname in ('public', 'app', 'auth', 'storage', 'supabase_migrations') and c.relkind in ('r', 'p', 'v', 'm', 'S')
      and pg_get_userbyid(c.relowner) <> app_user
      and not exists (select 1 from pg_depend d where d.objid = c.oid and d.deptype in ('e', 'a', 'i'))   -- not extension-owned, not a column's own sequence
  loop
    execute format('alter %s %s owner to %I', r.kind, r.obj, app_user);
  end loop;

  for r in
    select p.oid::regprocedure::text as sig, p.prokind
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'app', 'auth', 'storage', 'supabase_migrations')
      and pg_get_userbyid(p.proowner) <> app_user
      and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
  loop
    execute format('alter %s %s owner to %I', case r.prokind when 'p' then 'procedure' else 'function' end, r.sig, app_user);
  end loop;
end $$;
