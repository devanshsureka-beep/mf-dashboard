# Local stack without Docker (optional)

The recommended local setup is the Supabase CLI (`npx supabase start`, requires Docker). For machines or CI runners without Docker, this repository includes a small harness. It is the setup used to develop and verify this app:

| Service | How |
|---|---|
| PostgreSQL 15+ | Native install (`apt install postgresql`), on port 54322 |
| Supabase Auth (GoTrue) | Built from source with Go (`github.com/supabase/auth`), on port 9999 |
| API gateway + Storage stand-in | `node supabase/local-harness/gateway.mjs` on port 54321: proxies `/auth/v1` to GoTrue and emulates the few Storage endpoints the app uses on the local file system. **Dev only; it does not enforce storage RLS.** |

## Steps

```bash
# 1. Postgres cluster (as the postgres OS user)
initdb -D /tmp/pgdata -U postgres --auth=trust
pg_ctl -D /tmp/pgdata -o "-p 54322 -k /tmp" -l /tmp/pgdata/log start

# 2. Supabase roles + auth/storage schemas (stand-ins)
psql -h 127.0.0.1 -p 54322 -U postgres -f supabase/local-harness/bootstrap.sql

# 3. Supabase Auth (GoTrue)
go mod download -json github.com/supabase/auth@master     # note "Dir" in the output
cp -r <Dir> /tmp/gotrue-src && cd /tmp/gotrue-src && chmod -R u+w .
sed -i '/^replace github.com\/joho\/godotenv/d' go.mod && go build -o /tmp/gotrue .
JWT_SECRET=$(openssl rand -hex 32)
GOTRUE_API_HOST=127.0.0.1 PORT=9999 API_EXTERNAL_URL=http://127.0.0.1:54321/auth/v1 \
GOTRUE_SITE_URL=http://localhost:3000 GOTRUE_DB_DRIVER=postgres GOTRUE_DB_NAMESPACE=auth \
DATABASE_URL="postgres://supabase_auth_admin@127.0.0.1:54322/postgres?sslmode=disable" \
GOTRUE_JWT_SECRET=$JWT_SECRET GOTRUE_JWT_EXP=3600 GOTRUE_JWT_AUD=authenticated GOTRUE_JWT_ADMIN_ROLES=service_role \
GOTRUE_DISABLE_SIGNUP=true GOTRUE_EXTERNAL_EMAIL_ENABLED=true GOTRUE_MAILER_AUTOCONFIRM=true /tmp/gotrue &

# 4. Gateway (auth proxy + storage stand-in)
LOCAL_JWT_SECRET=$JWT_SECRET node supabase/local-harness/gateway.mjs &

# 5. Keys: sign two HS256 JWTs with $JWT_SECRET ({"role":"anon"} and {"role":"service_role"}, long expiry)
#    and put them in .env.local as NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY, with
#    NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321 and DATABASE_URL=postgresql://postgres@127.0.0.1:54322/postgres

# 6. Schema + data + app
npm run db:migrate
npm run seed
npm run dev
```

To reset the application schema (auth users are kept):

```bash
psql -h 127.0.0.1 -p 54322 -U postgres -f supabase/local-harness/reset.sql && npm run db:migrate && npm run seed
```

Integration tests use the same database: put `TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:54322/postgres` in `.env.test.local`.
