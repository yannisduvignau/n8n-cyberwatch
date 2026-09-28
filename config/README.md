# Configuration

Trois fichiers, aucun secret. Les secrets vivent dans `.env` (webhook
Discord, mots de passe) et dans les credentials n8n.

Après toute modification :

```bash
docker compose run --rm builder              # reconstruit le workflow
docker compose up -d --force-recreate n8n-init   # le déploie dans n8n
```

## `sources.yaml` — les flux surveillés

Ajouter un flux : recopier un bloc de quatre lignes.

```yaml
  - name: ANSSI – Actualités
    url: https://cyber.gouv.fr/actualites/rss/
    category: Multi
    type: Institutionnel
```

`category` est indicatif : c'est le scoring qui détermine le thème réel de
chaque article. `type` sert à pondérer la confiance accordée à la source.

Pour retirer un flux temporairement, le commenter plutôt que le supprimer :
il reste sous la main.

## `lexique.yaml` — le scoring

Le cœur du système. Chaque axe a trois cercles :

| Cercle | Sens | Points |
|---|---|---|
| `coeur` | le terme désigne le sujet lui-même | 3 |
| `peripherie` | le terme gravite autour du sujet | 2 |
| `signaux` | indice faible, à confirmer | 1 |

Un terme trouvé dans le titre compte double.

Réglages utiles :

- **trop de bruit** → monter `seuils.minimum`
- **on rate des choses** → descendre `seuils.minimum`, ou déplacer des termes
  de `signaux` vers `peripherie`
- **un terme ne se déclenche jamais** → la vue `v_mots_cles` le montre

L'`ancrage_ue` pénalise les articles sans marqueur européen sur les axes
listés. Il existe parce que « sovereign cloud » est un terme mondial : sans
lui, des articles sur Oracle en Inde franchissaient le seuil.

## `workflow.yaml` — les réglages généraux

Fréquence de collecte, fenêtre temporelle, seuils de notification,
concurrence réseau. Chaque valeur est commentée sur place.

Le `seuil_alerte` est utilisé à deux endroits (le nœud IF et le libellé du
message Discord) : le build les garde synchronisés, d'où l'intérêt de ne le
définir qu'ici.
