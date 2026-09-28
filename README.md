# Veille cyber UE — n8n

Veille automatisée sur quatre axes : **NIS2**, **Cyber Resilience Act**,
**cryptographie post-quantique** et **cloud souverain**.

Toutes les 2 heures, le workflow interroge ~34 flux RSS/Atom, note chaque
article selon un lexique par axe, archive le tout dans PostgreSQL et pousse
les articles les plus pertinents sur Discord. Metabase sert à l'exploration
et aux tableaux de bord.

Tout est auto-hébergé : aucune donnée de veille ne sort de la machine.

---

## Services

| Service | Rôle | Accès |
|---|---|---|
| `n8n` | orchestration du workflow | <http://localhost:5678> |
| `veille-db` | base métier : articles, journal de collecte | `localhost:5433` |
| `metabase` | exploration, tableaux de bord | <http://localhost:3000> |
| `n8n-postgres` | base interne de n8n (workflows, credentials) | — |

Les deux bases sont **volontairement séparées** : les données de veille ne
doivent pas cohabiter avec l'état interne de l'outil, pour survivre à une
mise à jour, une purge d'exécutions ou une réinstallation de n8n.

Tous les ports n'écoutent que sur `127.0.0.1`.

---

## Démarrage

```bash
cp .env.example .env
# puis remplir .env (voir ci-dessous)

docker compose up -d
```

Au premier démarrage, tout est provisionné automatiquement :

- le schéma SQL (`sql/`) est appliqué à la création de la base — 2 tables et
  6 vues d'analyse ;
- le service `n8n-init` crée le credential Postgres et importe le workflow,
  puis s'arrête.

Il ne reste qu'à créer le compte propriétaire sur <http://localhost:5678>.
Le credential apparaît alors dans *Settings → Credentials*, rattaché à votre
projet personnel, et le workflow est prêt à être activé.

Un `docker compose up -d` ultérieur rejoue le provisionnement sans créer de
doublon : l'import écrase les entrées par leur identifiant.

### Remplir le `.env`

| Variable | Comment l'obtenir |
|---|---|
| `POSTGRES_PASSWORD` | `openssl rand -hex 16` — base interne n8n |
| `VEILLE_PASSWORD` | `openssl rand -hex 16` — base de veille |
| `N8N_ENCRYPTION_KEY` | `openssl rand -hex 32` — **à conserver**, elle déchiffre les credentials |
| `DISCORD_WEBHOOK_URL` | Salon Discord → Paramètres → Intégrations → Créer un webhook |

Après toute modification du `.env` : `docker compose up -d` (un `restart` ne
recharge pas les variables).

### Réimporter le workflow après modification

Le provisionnement se rejoue seul, mais pour forcer un réimport immédiat :

```bash
docker compose up -d --force-recreate n8n-init
```

Pour importer une version modifiée depuis l'interface : menu ⋯ →
*Import from File* → `workflows/veille-cyber-ue.json`.

---

## Connecter Metabase

1. Ouvrir <http://localhost:3000>, créer le compte administrateur.
2. Ajouter une base de données **PostgreSQL** :
   hôte `veille-db`, port `5432`, base `veille`, utilisateur `veille`,
   mot de passe = `VEILLE_PASSWORD`.
3. Les vues apparaissent comme des tables, prêtes à l'emploi.

### Vues disponibles

| Vue | Ce qu'elle montre |
|---|---|
| `v_inbox` | ce qu'il reste à trier, le plus pertinent d'abord |
| `v_volume_par_jour` | volume et score moyen par jour et par axe |
| `v_sources` | sources les plus productives et leur qualité moyenne |
| `v_mots_cles` | termes du lexique qui se déclenchent réellement |
| `v_sante_flux` | flux en échec sur 7 jours, avec la dernière erreur |
| `v_avancement` | répartition par statut de lecture |
| `v_sujets_repris` | mêmes sujets couverts par plusieurs médias |

`v_sources` est la plus utile à l'usage : une source à fort volume et faible
score moyen produit du bruit et mérite d'être retirée.

---

## Fonctionnement

```
Toutes les 2 h
   └─ Sources ............... catalogue des flux (1 item par source)
      └─ Collecte des flux .. téléchargement parallèle, parsing, filtre 7 jours
         ├─ Journal ......... bilan par flux → feed_runs
         └─ Scoring ......... lexique par axe, calcul du score
            ├─ Archiver ..... INSERT ... ON CONFLICT DO NOTHING → articles
            └─ Score ≥ 8 ? .. → Discord
```

### Le scoring

Chaque axe possède un lexique en trois cercles :

| Cercle | Sens | Points |
|---|---|---|
| cœur | désigne le sujet lui-même | 3 |
| périphérie | gravite autour du sujet | 2 |
| signaux | indice faible à confirmer | 1 |

Un terme présent dans le **titre compte double** : un sujet annoncé dès le
titre est traité de front, alors qu'une occurrence dans le corps peut n'être
qu'une mention de passage.

Un article est retenu si son score total atteint `SEUIL_MIN` (3), et rattaché
à un axe si son score sur cet axe atteint `SEUIL_AXE` (3). Il peut donc porter
plusieurs thèmes.

**Ancrage européen.** « sovereign cloud » est un terme mondial : sans
garde-fou, des articles sur Oracle en Inde ou un opérateur du Golfe
franchissaient le seuil. Un article sans marqueur européen perd 4 points sur
l'axe *Cloud souverain*. Une pénalité, pas une exclusion : un vrai sujet
européen qui ne nomme jamais l'Europe reste détectable, il lui faut
simplement plus de termes.

Le détail du calcul est stocké dans `score_explain` et repris dans les
messages Discord — on voit toujours *pourquoi* un article a été retenu.

### Trier les articles

Le suivi de lecture se fait avec la colonne `status`
(`À évaluer`, `Retenu`, `Écarté`, `Archivé`) :

```sql
UPDATE articles SET status = 'Retenu', notes = 'à citer en intro'
WHERE id = 42;
```

Ces statuts **survivent aux exécutions suivantes** : réinsérer un article
connu ne l'écrase pas.

### Réglages courants

| Pour changer | Aller dans |
|---|---|
| la fréquence | nœud **Toutes les 2 h** |
| la sensibilité | `SEUIL_MIN` dans **Scoring par axe** |
| le seuil d'alerte Discord | nœud **Score élevé ?** (8 par défaut) |
| la fenêtre temporelle | `MAX_AGE_DAYS` dans **Collecte des flux** |
| les sources | nœud **Sources** |

---

## Exploitation

```bash
docker compose logs -f n8n        # suivre les logs
docker compose ps                 # état et santé des services
docker compose restart n8n        # redémarrer
docker compose down               # arrêter (les volumes sont conservés)
docker compose down -v            # tout supprimer, données comprises
```

Requêter la base directement :

```bash
docker exec -it veille-db psql -U veille -d veille
# ou depuis la machine hôte, port 5433
psql -h localhost -p 5433 -U veille -d veille
```

### Sauvegarde

```bash
# données de veille — c'est la sauvegarde qui compte
docker exec veille-db pg_dump -U veille veille > backups/veille-$(date +%F).sql

# configuration n8n (workflows, credentials chiffrés)
docker exec n8n-postgres pg_dump -U n8n n8n > backups/n8n-$(date +%F).sql
```

Restaurer la base n8n exige la **même** `N8N_ENCRYPTION_KEY`, sinon les
credentials stockés sont illisibles. La base de veille, elle, n'a pas cette
contrainte : c'est du SQL ordinaire.

---

## Notes de fonctionnement

**Les nœuds Code n'ont pas `fetch`.** Le sandbox de n8n n'expose pas les
globals de Node : la collecte utilise `this.helpers.httpRequest`, le client
HTTP fourni par n8n. C'est aussi pourquoi `N8N_RUNNERS_ENABLED` est à `false`
dans le compose.

**Un flux en échec ne bloque rien.** Chaque téléchargement est isolé dans son
`try/catch` : un 403, un timeout ou un domaine mort est enregistré dans
`feed_runs` puis ignoré, les autres sources continuent. Pour repérer les flux
à retirer :

```sql
SELECT * FROM v_sante_flux WHERE echecs > 0;
```

**Les reprises entre médias sont signalées, pas supprimées.** Un même sujet
couvert par trois médias donne trois lignes. C'est délibéré : j'ai testé la
fusion automatique par similarité de titres, aucun seuil ne séparait « la
France transpose NIS2 » de « l'Allemagne transpose NIS2 » sans laisser
passer de vrais doublons. En veille réglementaire, fusionner à tort fait
disparaître une information — le coût est asymétrique.

La vue `v_sujets_repris` regroupe donc les articles dont les titres
partagent au moins 60 % de leur vocabulaire, à vous de trancher :

```sql
SELECT * FROM v_sujets_repris;
-- puis, pour écarter une reprise :
UPDATE articles SET status = 'Écarté' WHERE id = 57;
```

**Le dédoublonnage strict est garanti par la base.** La contrainte
`UNIQUE (dedup_key)` et le `ON CONFLICT DO NOTHING` rendent l'insertion
idempotente : rejouer une exécution ne crée aucun doublon et ne réinitialise
aucun statut de lecture. C'est plus robuste qu'un historique glissant côté
n8n, qui peut être purgé ou dériver.

**Les sources peu actives sont invisibles.** Le filtre à 7 jours écarte les
blogs qui publient moins souvent — le flux Cloudflare post-quantum, par
exemple, ressort souvent vide. C'est voulu : augmenter `MAX_AGE_DAYS` les
fait réapparaître, au prix de redites à chaque cycle.

**Les liens Google News restent des redirections.** Résoudre l'URL finale
demande de franchir un mur de consentement qui renvoie une erreur. Le vrai
éditeur est en revanche récupéré depuis le champ `<source>` du flux : les
colonnes `source` et `domain` sont donc justes, seul le lien passe par Google.

---

## Sécurité

- Aucun secret dans `workflows/veille-cyber-ue.json` : le webhook vient de
  `$env`, la base d'un credential n8n. Le fichier est partageable tel quel.
- Le `.env` est exclu du dépôt par `.gitignore`.
- Tous les services n'écoutent que sur `127.0.0.1`. Pour un accès distant,
  passer par un reverse proxy en HTTPS et repasser `N8N_SECURE_COOKIE` à `true`.
- `N8N_BLOCK_ENV_ACCESS_IN_NODE` est à `false`, ce qu'exige la lecture de
  `$env` dans les nœuds Code. Les nœuds Code ont donc accès à toutes les
  variables d'environnement du conteneur : n'y placer que ce qui concerne
  ce workflow.
- Le provisionnement écrit le mot de passe de la base dans un fichier
  temporaire à l'intérieur du conteneur `n8n-init`, supprimé à la sortie du
  script (`trap`) et de toute façon détruit avec le conteneur. C'est le prix
  de `n8n import:credentials`, qui ne lit pas depuis l'entrée standard.
  En déploiement partagé, préférer un gestionnaire de secrets externe.
