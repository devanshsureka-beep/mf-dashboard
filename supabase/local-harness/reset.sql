-- Docker-less local harness ONLY: wipe application schema so migrations and
-- seed can be re-applied. Auth users are kept. NEVER run against production.
drop schema if exists app cascade;
drop schema if exists public cascade;
drop schema if exists supabase_migrations cascade;
create schema public;
grant usage on schema public to anon, authenticated, service_role;
grant all on schema public to postgres;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
delete from storage.objects;
