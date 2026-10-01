# Two setups: Local (try changes) and Live (the team uses it)

| | **Local** (your computer) | **Live** (the team) |
|---|---|---|
| Address | http://localhost:3000 | https://mf-dashboard-coral.vercel.app |
| Code | any branch you check out | the `main` branch only |
| Database | Supabase project **mn-advisory-staging** (test data) | Supabase project **mn-advisory** (real clients) |
| Updates | instantly, as files change | only when `main` changes |
| Cost of a change | nothing is deployed | one Vercel deployment per release |

Changes are made and checked locally first. When you are happy, one merge into `main` makes them live. There are no redeploys while you are still trying things out.

```
 edit / ask Claude  ──►  working branch  ──►  your computer (npm run dev)  ──►  happy?  ──►  merge into main  ──►  Vercel deploys live
                                                  test database                               (pull request)       real database
```

---

## A. One-time: make `main` the only thing that goes live (Vercel)

1. Vercel → project **mf-dashboard** → **Settings → Environments → Production → Branch Tracking**: set the branch to **`main`**.
   Changing this does **not** redeploy. The site keeps running the current version until `main` changes.
2. Stop building every pushed branch: open **Settings → Git → Ignored Build Step**, choose **Custom** and paste:
   ```bash
   if [ "$VERCEL_GIT_COMMIT_REF" = "main" ]; then exit 1; else exit 0; fi
   ```
   (Vercel builds when this exits 1, so only `main` is built.)
3. Before the first release from `main`, `main` must contain everything that is live today. Ask Claude to open a pull request
   from the working branch into `main`, then merge it on GitHub. That merge is the first deployment from `main`.

## B. One-time: your computer

You need **Node.js 22 LTS** (https://nodejs.org) and **Git** (https://git-scm.com), or GitHub Desktop.

```bash
git clone https://github.com/devanshsureka-beep/mf-dashboard.git
cd mf-dashboard
npm install
```

Create a file named **`.env.local`** in the `mf-dashboard` folder. It holds the **test** database keys, so nothing you do locally touches live clients.
Never put live (production) keys in it, and never commit it (Git already ignores it).

| Variable | Where to get it (Supabase project **mn-advisory-staging**) |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | `https://yllcgljyjogamzubiawj.supabase.co` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Project Settings → API Keys → `anon` / publishable key |
| `SUPABASE_SERVICE_ROLE_KEY` | Project Settings → API Keys → `service_role` / secret key (keep private) |
| `DATABASE_URL` | Connect (top bar) → Transaction pooler → URI (port 6543), with the database password filled in |
| `APP_ENV` | `staging` (shows the amber TEST banner) |
| `CAS_PASSWORD_TEMPLATE` | the same template the team uses (ask the admin; it is a secret) |
| `INTEGRATION_API_KEY` | any long random string (only needed to test the n8n endpoints locally) |

Then start it:

```bash
npm run dev
```

Open http://localhost:3000 and sign in with your **staging** account. Pages reload as soon as a file changes.

## C. Every change

1. **Get the change onto your computer**
   - If Claude made the change, it is pushed to a branch (e.g. `claude/…`). Run:
     ```bash
     git fetch origin
     git checkout <branch-name>      # the branch Claude names
     git pull
     npm install                     # only if package.json changed
     ```
   - If the change adds a database migration (`supabase/migrations/…`), Claude applies it to the **staging** database first.
2. **Run and check:** `npm run dev`, then try the change at http://localhost:3000 with test documents and test clients.
3. **Go live:** ask Claude to open a pull request into `main` (or open it on GitHub), review, and **Merge**.
   Vercel builds `main` (about 2 minutes) and the team gets the change. Migrations are applied to the live database just before the merge.
4. **Undo a bad release:** Vercel → Deployments → the previous production deployment → **Instant Rollback**.

## D. Good to know

- **Document Check** (`/onboard/check`) is read-only and safe on the live site too.
- The daily NAV feed (n8n) posts to the live site. To test it locally, send the AMFI file to
  `http://localhost:3000/api/integrations/nav-update` with your local `INTEGRATION_API_KEY` (see `docs/INTEGRATIONS.md`, section 6).
- If you prefer a database on your own machine instead of the staging project, see `docs/LOCAL_WITHOUT_DOCKER.md` or use `supabase start`.
