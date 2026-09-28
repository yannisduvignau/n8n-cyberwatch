#!/usr/bin/env python3
"""
Assemble le workflow n8n à partir des fichiers de configuration et des
nœuds Code.

    config/*.yaml  +  src/*.js  ->  workflows/veille-cyber-ue.json

Les nœuds Code portent des marqueurs `/* @@NOM@@ */ valeur` : le build
remplace la valeur par ce que dit la configuration. Le défaut écrit dans le
fichier reste valide, si bien qu'un nœud reste lisible et testable seul.

Usage :
    docker compose run --rm builder          # construit
    docker compose run --rm builder --check  # vérifie sans écrire
"""

import json
import re
import sys
from pathlib import Path

RACINE = Path(__file__).resolve().parent.parent
CONFIG = RACINE / 'config'
SRC = RACINE / 'src'
SORTIE = RACINE / 'workflows'

try:
    import yaml
except ImportError:
    sys.exit("PyYAML manquant. Lancer via : docker compose run --rm builder")


# --- Chargement -------------------------------------------------------------

def charger(nom):
    chemin = CONFIG / nom
    if not chemin.exists():
        sys.exit(f"Configuration absente : {chemin.relative_to(RACINE)}")
    with chemin.open(encoding='utf-8') as f:
        return yaml.safe_load(f)


def js(valeur):
    """Sérialise une valeur Python en littéral JavaScript lisible."""
    return json.dumps(valeur, ensure_ascii=False, indent=2)


def injecter(code, marqueurs):
    """
    Remplace chaque `/* @@NOM@@ */ <défaut>` par la valeur fournie.

    Le défaut peut être un objet, un tableau ou un scalaire ; on s'arrête au
    premier point-virgule de fin de ligne, ce qui suffit pour nos formes.
    """
    for nom, valeur in marqueurs.items():
        motif = re.compile(
            r'/\* @@' + re.escape(nom) + r'@@ \*/\s*(?:\{[^;]*\}|\[[^;]*\]|[^;\n]+)'
        )
        if not motif.search(code):
            sys.exit(f"Marqueur @@{nom}@@ introuvable — le nœud a-t-il été modifié ?")
        # Le marqueur disparaît au profit d'un rappel de provenance : le
        # fichier généré ne doit pas ressembler à un fichier réinjectable.
        code = motif.sub(
            lambda _m, v=valeur, n=nom: f'/* {n} — config */ {js(v)}', code, count=1)
    return code


def lire_noeud(fichier, marqueurs=None):
    code = (SRC / fichier).read_text(encoding='utf-8')
    return injecter(code, marqueurs) if marqueurs else code


# --- Construction -----------------------------------------------------------

def construire():
    wf_cfg = charger('workflow.yaml')
    sources = charger('sources.yaml')['sources']
    lex = charger('lexique.yaml')

    col = wf_cfg['collecte']
    notif = wf_cfg['notification']

    code_sources = lire_noeud('01-sources.js', {'SOURCES': sources})
    code_collecte = lire_noeud('02-collecte.js', {
        'AGE_MAX_JOURS': col['age_max_jours'],
        'TIMEOUT_MS': col['timeout_ms'],
        'CONCURRENCE': col['concurrence'],
        'MAX_ARTICLES_PAR_FLUX': col['max_articles_par_flux'],
    })
    code_scoring = lire_noeud('03-scoring.js', {
        'SEUIL_AXE': lex['seuils']['axe'],
        'SEUIL_MIN': lex['seuils']['minimum'],
        'POIDS': {k: lex['poids'][k] for k in ('coeur', 'peripherie', 'signaux')},
        'BONUS_TITRE': lex['poids']['bonus_titre'],
        'AXES': lex['axes'],
        'EXCLUSIONS': lex['exclusions'],
        'MARQUEURS_UE': lex['ancrage_ue']['marqueurs'],
        'AXES_ANCRAGE_UE': lex['ancrage_ue']['axes'],
        'MALUS_HORS_UE': lex['ancrage_ue']['malus'],
    })
    code_postgres = lire_noeud('04-postgres.js')
    code_discord = lire_noeud('05-discord.js', {
        'SEUIL_URGENT': notif['seuil_urgent'],
        'SEUIL_ALERTE': notif['seuil_alerte'],
    })
    code_journal = lire_noeud('06-journal.js')

    note = (RACINE / 'build' / 'note.md').read_text(encoding='utf-8')

    def noeud(nom, type_, version, pos, params, **extra):
        n = {"parameters": params, "id": nom, "name": nom,
             "type": type_, "typeVersion": version, "position": pos}
        n.update(extra)
        return n

    cred = {"postgres": {"id": wf_cfg['base']['credential_id'],
                         "name": wf_cfg['base']['credential']}}

    noeuds = [
        noeud("Mode d'emploi", "n8n-nodes-base.stickyNote", 1, [-160, -80],
              {"content": note, "height": 620, "width": 460}),

        noeud("Toutes les 2 h", "n8n-nodes-base.scheduleTrigger", 1.2, [360, 300],
              {"rule": {"interval": [{"field": "hours",
                                      "hoursInterval": wf_cfg['planification']['intervalle_heures']}]}}),

        noeud("Sources", "n8n-nodes-base.code", 2, [580, 300],
              {"mode": "runOnceForAllItems", "jsCode": code_sources}),

        noeud("Collecte des flux", "n8n-nodes-base.code", 2, [800, 300],
              {"mode": "runOnceForAllItems", "jsCode": code_collecte},
              onError="continueRegularOutput", retryOnFail=True,
              maxTries=2, waitBetweenTries=5000),

        noeud("Scoring par axe", "n8n-nodes-base.code", 2, [1020, 300],
              {"mode": "runOnceForAllItems", "jsCode": code_scoring}),

        # --- archivage
        noeud("Préparer l'insertion", "n8n-nodes-base.code", 2, [1260, 160],
              {"mode": "runOnceForAllItems", "jsCode": code_postgres}),

        noeud("Archiver en base", "n8n-nodes-base.postgres", 2.5, [1480, 160],
              {"operation": "executeQuery",
               "query": (
                   "INSERT INTO articles (dedup_key, title_vocab, title, url, domain, source, author,\n"
                   "                      feed, category, source_type, excerpt, published_at, score,\n"
                   "                      weak_signal, themes, keywords, score_detail, score_explain)\n"
                   "VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::timestamptz, $13::int,\n"
                   "        $14::boolean, $15::text[], $16::text[], $17::jsonb, $18::text[])\n"
                   "ON CONFLICT (dedup_key) DO NOTHING\n"
                   "RETURNING id, score, title;"
               ),
               "options": {"queryReplacement":
                   "={{ [$json.dedup_key, $json.title_vocab, $json.title, $json.url, "
                   "$json.domain, $json.source, $json.author, $json.feed, "
                   "$json.category, $json.source_type, $json.excerpt, "
                   "$json.published_at, $json.score, $json.weak_signal, "
                   "$json.themes, $json.keywords, $json.score_detail, "
                   "$json.score_explain] }}"}},
              credentials=cred, onError="continueRegularOutput",
              retryOnFail=True, maxTries=3, waitBetweenTries=2000),

        # --- journal
        noeud("Préparer le journal", "n8n-nodes-base.code", 2, [1260, -20],
              {"mode": "runOnceForAllItems", "jsCode": code_journal}),

        noeud("Journaliser les flux", "n8n-nodes-base.postgres", 2.5, [1480, -20],
              {"operation": "executeQuery",
               "query": ("INSERT INTO feed_runs (feed, status, detail, items_found, items_kept)\n"
                         "VALUES ($1, $2, $3, $4::int, $5::int);"),
               "options": {"queryReplacement":
                   "={{ [$json.feed, $json.status, $json.detail, "
                   "$json.items_found, $json.items_kept] }}"}},
              credentials=cred, onError="continueRegularOutput",
              retryOnFail=True, maxTries=2, waitBetweenTries=2000),

        # --- notification
        noeud("Score élevé ?", "n8n-nodes-base.if", 2, [1260, 440],
              {"conditions": {
                  "options": {"caseSensitive": True, "leftValue": "",
                              "typeValidation": "strict", "version": 2},
                  "conditions": [{"id": "seuil-alerte",
                                  "leftValue": "={{ $json.score }}",
                                  "rightValue": notif['seuil_alerte'],
                                  "operator": {"type": "number", "operation": "gte"}}],
                  "combinator": "and"},
               "options": {}}),

        noeud("Préparer message Discord", "n8n-nodes-base.code", 2, [1480, 440],
              {"mode": "runOnceForAllItems", "jsCode": code_discord}),

        noeud("Notifier l'équipe", "n8n-nodes-base.httpRequest", 4.2, [1700, 440],
              {"method": "POST", "url": "={{ $env.DISCORD_WEBHOOK_URL }}",
               "sendBody": True, "specifyBody": "json",
               "jsonBody": "={{ JSON.stringify($json.payload) }}",
               "options": {"batching": {"batch": {"batchSize": 1, "batchInterval": 1200}},
                           "timeout": 15000}},
              onError="continueRegularOutput", retryOnFail=True,
              maxTries=3, waitBetweenTries=3000),
    ]

    def lien(cible, index=0):
        return {"node": cible, "type": "main", "index": index}

    connexions = {
        "Toutes les 2 h": {"main": [[lien("Sources")]]},
        "Sources": {"main": [[lien("Collecte des flux")]]},
        # La collecte alimente le scoring et, en parallèle, le journal.
        "Collecte des flux": {"main": [[lien("Scoring par axe"), lien("Préparer le journal")]]},
        "Préparer le journal": {"main": [[lien("Journaliser les flux")]]},
        "Scoring par axe": {"main": [[lien("Préparer l'insertion"), lien("Score élevé ?")]]},
        "Préparer l'insertion": {"main": [[lien("Archiver en base")]]},
        # sortie 0 = true ; sortie 1 = false, volontairement non connectée :
        # ces articles sont archivés mais ne déclenchent pas d'alerte.
        "Score élevé ?": {"main": [[lien("Préparer message Discord")], []]},
        "Préparer message Discord": {"main": [[lien("Notifier l'équipe")]]},
    }

    return {
        "name": wf_cfg['nom'],
        "nodes": noeuds,
        "connections": connexions,
        "active": False,
        "settings": {"executionOrder": "v1", "saveManualExecutions": True,
                     "saveExecutionProgress": True, "executionTimeout": 900,
                     "timezone": "Europe/Paris"},
        "pinData": {},
        "tags": [],
        "meta": {"instanceId": "veille-cyber-ue"},
    }


# --- Vérifications ----------------------------------------------------------

def verifier(wf):
    """Garde-fous : un JSON syntaxiquement correct peut rester incohérent."""
    noms = {n['name'] for n in wf['nodes']}
    erreurs = []

    for source, conn in wf['connections'].items():
        if source not in noms:
            erreurs.append(f"connexion depuis un nœud inconnu : {source}")
        for sortie in conn['main']:
            for l in sortie:
                if l['node'] not in noms:
                    erreurs.append(f"connexion vers un nœud inconnu : {l['node']}")

    atteints = set()

    def parcourir(n):
        if n in atteints:
            return
        atteints.add(n)
        for sortie in wf['connections'].get(n, {}).get('main', []):
            for l in sortie:
                parcourir(l['node'])

    declencheurs = [n['name'] for n in wf['nodes']
                    if n['type'].endswith(('scheduleTrigger', 'manualTrigger'))]
    for d in declencheurs:
        parcourir(d)

    for n in wf['nodes']:
        if n['type'].endswith(('stickyNote', 'scheduleTrigger', 'manualTrigger')):
            continue
        if n['name'] not in atteints:
            erreurs.append(f"nœud orphelin : {n['name']}")

    blob = json.dumps(wf, ensure_ascii=False)
    if 'discord.com/api/webhooks/' in blob:
        erreurs.append("webhook Discord en dur dans le workflow")
    restants = set(re.findall(r'@@(\w+)@@', blob))
    if restants:
        erreurs.append(f"marqueurs non résolus : {', '.join(sorted(restants))}")

    return erreurs


def main():
    check = '--check' in sys.argv
    wf = construire()

    erreurs = verifier(wf)
    if erreurs:
        print("Échec de la vérification :", file=sys.stderr)
        for e in erreurs:
            print(f"  ✗ {e}", file=sys.stderr)
        sys.exit(1)

    nb_sources = len(charger('sources.yaml')['sources'])
    lex = charger('lexique.yaml')
    nb_termes = sum(len(v) for axe in lex['axes'].values() for v in axe.values())

    if check:
        print(f"✓ configuration valide — {len(wf['nodes'])} nœuds, "
              f"{nb_sources} sources, {nb_termes} termes")
        return

    SORTIE.mkdir(exist_ok=True)
    principal = SORTIE / 'veille-cyber-ue.json'
    principal.write_text(json.dumps(wf, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')

    # Variante attendue par `n8n import:workflow`, qui veut un tableau.
    (SORTIE / '_import.json').write_text(
        json.dumps([wf], ensure_ascii=False, indent=2) + '\n', encoding='utf-8')

    print(f"✓ {principal.relative_to(RACINE)} — {len(wf['nodes'])} nœuds, "
          f"{nb_sources} sources, {nb_termes} termes")
    print("  Pour déployer : docker compose up -d --force-recreate n8n-init")


if __name__ == '__main__':
    main()
