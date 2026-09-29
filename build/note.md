## Watch — EU cyber regulation & sovereignty

Topics: **NIS2** · **CRA** · **PQC** · **Cloud souverain**

### Processing chain
1. **Sources** — catalogue of RSS/Atom feeds, one item per source
2. **Collecte** — downloads feeds in parallel, normalises, keeps the last 7 days
3. **Scoring** — 3-circle lexicon per topic, multi-topic tagging
4. **Archiver** — insert into the `veille` database, `articles` table
5. **Discord** — articles scoring ≥ 8 are posted to the team channel
6. **Journal** — per-feed report in `feed_runs`, to spot dead feeds

Deduplication is handled by the `UNIQUE (dedup_key)` constraint in the
database: an already known article is skipped without overwriting its
reading status.

### Configuration
No secrets in this workflow. The webhook comes from `$env.DISCORD_WEBHOOK_URL`,
the database from a Postgres credential in n8n (Settings → Credentials):
host `veille-db`, port `5432`, database `veille`.

### Reading the results
Metabase at <http://localhost:3000> — the `v_inbox`, `v_sources`,
`v_volume_par_jour` and `v_sante_flux` views are ready to use.

### Common settings
Edit the files in `config/`, then rebuild (`docker compose run --rm builder`):
- frequency → `workflow.yaml`, node **Toutes les 2 h**
- sensitivity → `lexique.yaml` (`seuils.minimum`), node **Scoring par axe**
- alert threshold → `workflow.yaml` (`notification.seuil_alerte`), node **Score élevé ?** (8 by default)
- sources → `sources.yaml`, node **Sources**
