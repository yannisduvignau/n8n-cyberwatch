## Veille — Régulation & souveraineté cyber UE

Axes : **NIS2** · **CRA** · **PQC** · **Cloud souverain**

### Chaîne de traitement
1. **Sources** — catalogue des flux RSS/Atom, un item par source
2. **Collecte** — télécharge les flux en parallèle, normalise, filtre à 7 jours
3. **Scoring** — lexique en 3 cercles par axe, tag multi-axes
4. **Archiver** — insertion dans la base `veille`, table `articles`
5. **Discord** — les articles de score ≥ 8 partent dans le salon d'équipe
6. **Journal** — bilan par flux dans `feed_runs`, pour repérer les flux morts

Le dédoublonnage est assuré par la contrainte `UNIQUE (dedup_key)` en base :
un article déjà connu est ignoré sans écraser son statut de lecture.

### Configuration
Aucun secret dans ce workflow. Le webhook vient de `$env.DISCORD_WEBHOOK_URL`,
la base d'un credential Postgres à créer dans n8n (Settings → Credentials) :
hôte `veille-db`, port `5432`, base `veille`.

### Lecture des résultats
Metabase sur <http://localhost:3000> — les vues `v_inbox`, `v_sources`,
`v_volume_par_jour` et `v_sante_flux` sont prêtes à l'emploi.

### Réglages courants
- fréquence → nœud **Toutes les 2 h**
- sensibilité → `SEUIL_MIN` dans **Scoring par axe**
- seuil d'alerte → nœud **Score élevé ?** (8 par défaut)
- sources → nœud **Sources**