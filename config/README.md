# Configuration

Three files, no secrets. Secrets live in `.env` (Discord webhook, passwords)
and in the n8n credentials.

After any change:

```bash
docker compose run --rm builder                  # rebuild the workflow
docker compose up -d --force-recreate n8n-init   # deploy it to n8n
```

## `sources.yaml` — the monitored feeds

To add a feed, copy a four-line block:

```yaml
  - name: ANSSI – Actualités
    url: https://cyber.gouv.fr/actualites/rss/
    category: Multi
    type: Institutionnel
```

`category` is only a hint: scoring decides the actual theme of each article.
`type` is used to weigh the trust given to the source.

To remove a feed temporarily, comment it out rather than deleting it, so it
stays at hand.

## `lexique.yaml` — scoring

The heart of the system. Each topic has three circles:

| Circle | Meaning | Points |
|---|---|---|
| `coeur` (core) | the term names the subject itself | 3 |
| `peripherie` (periphery) | the term revolves around the subject | 2 |
| `signaux` (signals) | weak hint, to be confirmed | 1 |

A term found in the title counts double.

Useful adjustments:

- **too much noise** → raise `seuils.minimum`
- **things are being missed** → lower `seuils.minimum`, or move terms from
  `signaux` to `peripherie`
- **a term never fires** → the `v_mots_cles` view shows it

`ancrage_ue` penalises articles with no European marker on the listed
topics. It exists because "sovereign cloud" is a global term: without it,
articles about Oracle in India crossed the threshold.

## `workflow.yaml` — general settings

Collection frequency, time window, notification thresholds, network
concurrency. Each value is commented in place.

`seuil_alerte` is used in two places (the IF node and the Discord message
label): the build keeps them in sync, which is why it should only be defined
here.
