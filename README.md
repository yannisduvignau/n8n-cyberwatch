# EU cyber watch — n8n

Automated monitoring of four topics: **NIS2**, the **Cyber Resilience Act**,
**post-quantum cryptography** and **sovereign cloud**.

Every 2 hours, the workflow polls ~34 RSS/Atom feeds, scores each article
against a per-topic lexicon, archives everything in PostgreSQL and pushes the
most relevant articles to Discord. Metabase is used for exploration and
dashboards.

Everything is self-hosted: no monitoring data ever leaves the machine.

---

## Services

| Service | Role | Access |
|---|---|---|
| `n8n` | workflow orchestration | <http://localhost:5678> |
| `veille-db` | business database: articles, collection log | `localhost:5433` |
| `metabase` | exploration, dashboards | <http://localhost:3000> |
| `n8n-postgres` | n8n's internal database (workflows, credentials) | — |

The two databases are **deliberately separate**: monitoring data must not
live alongside the tool's internal state, so that it survives an upgrade, an
execution purge or a reinstall of n8n.

All ports listen on `127.0.0.1` only.

---

## Getting started

```bash
cp .env.example .env
# then fill in .env (see below)

docker compose up -d
```

On first start, everything is provisioned automatically:

- the SQL schema (`sql/`) is applied when the database is created — 2 tables
  and 7 analysis views;
- the `n8n-init` service creates the Postgres credential and imports the
  workflow, then exits.

All that's left is to create the owner account at <http://localhost:5678>.
The credential then shows up in *Settings → Credentials*, attached to your
personal project, and the workflow is ready to be activated.

A later `docker compose up -d` replays the provisioning without creating
duplicates: the import overwrites entries by their ID.

### Filling in `.env`

| Variable | How to get it |
|---|---|
| `POSTGRES_PASSWORD` | `openssl rand -hex 16` — n8n internal database |
| `VEILLE_PASSWORD` | `openssl rand -hex 16` — monitoring database |
| `N8N_ENCRYPTION_KEY` | `openssl rand -hex 32` — **keep it safe**, it decrypts the credentials |
| `DISCORD_WEBHOOK_URL` | Discord channel → Settings → Integrations → Create Webhook |

After any change to `.env`: `docker compose up -d` (a `restart` does not
reload the variables).

### Re-importing the workflow after a change

Provisioning replays on its own, but to force an immediate re-import:

```bash
docker compose up -d --force-recreate n8n-init
```

To import a modified version from the UI: ⋯ menu →
*Import from File* → `workflows/veille-cyber-ue.json`.

---

## Connecting Metabase

1. Open <http://localhost:3000> and create the admin account.
2. Add a **PostgreSQL** database:
   host `veille-db`, port `5432`, database `veille`, user `veille`,
   password = `VEILLE_PASSWORD`.
3. The views show up as tables, ready to use.

### Available views

| View | What it shows |
|---|---|
| `v_inbox` | what is left to triage, most relevant first |
| `v_volume_par_jour` | volume and average score per day and per topic |
| `v_sources` | most productive sources and their average quality |
| `v_mots_cles` | lexicon terms that actually fire |
| `v_sante_flux` | feeds failing over the last 7 days, with the latest error |
| `v_avancement` | breakdown by reading status |
| `v_sujets_repris` | same stories covered by several outlets |

`v_sources` is the most useful in practice: a high-volume source with a low
average score produces noise and deserves to be removed.

---

## Project layout

```
config/     settings: sources, scoring lexicon, general parameters
src/        Code node sources, one file per node
build/      assembly script config + src -> workflow JSON
sql/        schema and views, applied when the database is created
scripts/    n8n provisioning at startup
workflows/  generated JSON — do not edit by hand
```

The workflow is not written directly in JSON: it is **assembled** from
`config/` and `src/`. Editing `workflows/veille-cyber-ue.json` works, but the
change will be overwritten by the next build.

```bash
docker compose run --rm builder            # rebuild
docker compose run --rm builder --check    # validate without writing
```

The build refuses to write if a node is orphaned, if a connection points to
a non-existent node, or if a secret has slipped into the JSON.

## How it works

```
Toutes les 2 h
   └─ Sources ............... feed catalogue (1 item per source)
      └─ Collecte des flux .. parallel download, parsing, 7-day filter
         ├─ Journal ......... per-feed report → feed_runs
         └─ Scoring ......... per-topic lexicon, score computation
            ├─ Archiver ..... INSERT ... ON CONFLICT DO NOTHING → articles
            └─ Score ≥ 8 ? .. → Discord
```

### Scoring

Each topic has a lexicon made of three circles:

| Circle | Meaning | Points |
|---|---|---|
| core (`coeur`) | names the subject itself | 3 |
| periphery (`peripherie`) | revolves around the subject | 2 |
| signals (`signaux`) | weak hint, to be confirmed | 1 |

A term found in the **title counts double**: a subject announced in the
title is being addressed head-on, whereas an occurrence in the body may be a
passing mention.

An article is kept if its total score reaches `SEUIL_MIN` (3), and attached
to a topic if its score on that topic reaches `SEUIL_AXE` (3). It can
therefore carry several themes.

**European anchoring.** "Sovereign cloud" is a global term: without a
safeguard, articles about Oracle in India or a Gulf operator crossed the
threshold. An article with no European marker loses 4 points on the
*Cloud souverain* topic. It is a penalty, not an exclusion: a genuinely
European story that never names Europe is still detectable, it just needs
more terms.

The breakdown of the computation is stored in `score_explain` and repeated
in the Discord messages — you can always see *why* an article was kept.

### Triaging articles

Reading progress is tracked with the `status` column
(`À évaluer`, `Retenu`, `Écarté`, `Archivé` — to review, kept, discarded,
archived):

```sql
UPDATE articles SET status = 'Retenu', notes = 'quote in the intro'
WHERE id = 42;
```

These statuses **survive subsequent executions**: re-inserting a known
article does not overwrite it.

### Common settings

Everything is configured in `config/`, not in the n8n UI:

| To change | File | Key |
|---|---|---|
| the sources | `config/sources.yaml` | — |
| scoring sensitivity | `config/lexique.yaml` | `seuils.minimum` |
| a topic's lexicon | `config/lexique.yaml` | `axes.<axe>` |
| the frequency | `config/workflow.yaml` | `planification.intervalle_heures` |
| the Discord alert threshold | `config/workflow.yaml` | `notification.seuil_alerte` |
| the time window | `config/workflow.yaml` | `collecte.age_max_jours` |

Then rebuild and deploy:

```bash
docker compose run --rm builder
docker compose up -d --force-recreate n8n-init
```

See `config/README.md` for details on each file.

---

## Operations

```bash
docker compose logs -f n8n        # follow the logs
docker compose ps                 # service state and health
docker compose restart n8n        # restart
docker compose down               # stop (volumes are kept)
docker compose down -v            # delete everything, data included
```

Querying the database directly:

```bash
docker exec -it veille-db psql -U veille -d veille
# or from the host machine, port 5433
psql -h localhost -p 5433 -U veille -d veille
```

### Backups

```bash
# monitoring data — this is the backup that matters
docker exec veille-db pg_dump -U veille veille > backups/veille-$(date +%F).sql

# n8n configuration (workflows, encrypted credentials)
docker exec n8n-postgres pg_dump -U n8n n8n > backups/n8n-$(date +%F).sql
```

Restoring the n8n database requires the **same** `N8N_ENCRYPTION_KEY`,
otherwise the stored credentials are unreadable. The monitoring database has
no such constraint: it is plain SQL.

---

## Operating notes

**Code nodes don't have `fetch`.** The n8n sandbox does not expose Node's
globals: collection uses `this.helpers.httpRequest`, the HTTP client provided
by n8n. This is also why `N8N_RUNNERS_ENABLED` is set to `false` in the
compose file.

**A failing feed blocks nothing.** Each download is isolated in its own
`try/catch`: a 403, a timeout or a dead domain is recorded in `feed_runs`
and then skipped, and the other sources carry on. To spot feeds that should
be removed:

```sql
SELECT * FROM v_sante_flux WHERE echecs > 0;
```

**Cross-outlet coverage is flagged, not removed.** The same story covered by
three outlets yields three rows. This is deliberate: I tested automatic
merging based on title similarity, and no threshold could separate "France
transposes NIS2" from "Germany transposes NIS2" without letting real
duplicates through. In regulatory monitoring, a wrong merge makes a piece of
information disappear — the cost is asymmetric.

The `v_sujets_repris` view therefore groups articles whose titles share at
least 60% of their vocabulary, and leaves the call to you:

```sql
SELECT * FROM v_sujets_repris;
-- then, to discard a duplicate story:
UPDATE articles SET status = 'Écarté' WHERE id = 57;
```

**Strict deduplication is guaranteed by the database.** The
`UNIQUE (dedup_key)` constraint and `ON CONFLICT DO NOTHING` make insertion
idempotent: replaying an execution creates no duplicates and resets no
reading status. This is more robust than a sliding history on the n8n side,
which can be purged or drift.

**Low-activity sources are invisible.** The 7-day filter drops blogs that
publish less often — the Cloudflare post-quantum feed, for instance, often
comes back empty. This is intended: raising `collecte.age_max_jours` brings
them back, at the cost of repeats on every cycle.

**Google News links remain redirects.** Resolving the final URL requires
getting past a consent wall that returns an error. The real publisher is,
however, retrieved from the feed's `<source>` field: the `source` and
`domain` columns are therefore correct, only the link goes through Google.

---

## Security

- No secrets in `workflows/veille-cyber-ue.json`: the webhook comes from
  `$env`, the database from an n8n credential. The file can be shared as is.
- `.env` is excluded from the repository by `.gitignore`.
- All services listen on `127.0.0.1` only. For remote access, go through an
  HTTPS reverse proxy and set `N8N_SECURE_COOKIE` back to `true`.
- `N8N_BLOCK_ENV_ACCESS_IN_NODE` is set to `false`, which reading `$env` in
  Code nodes requires. Code nodes therefore have access to all of the
  container's environment variables: only put there what concerns this
  workflow.
- Provisioning writes the database password to a temporary file inside the
  `n8n-init` container, deleted when the script exits (`trap`) and destroyed
  with the container anyway. That is the price of `n8n import:credentials`,
  which does not read from standard input. For a shared deployment, prefer
  an external secrets manager.
