/**
 * SCORING PAR AXE
 *
 * Chaque axe de veille possède un lexique en trois cercles concentriques :
 *
 *   coeur       le terme désigne le sujet lui-même          3 pts
 *   peripherie  le terme gravite autour du sujet            2 pts
 *   signaux     indice faible, à confirmer par le contexte  1 pt
 *
 * Un terme trouvé dans le titre compte double : un sujet annoncé dès le
 * titre est traité de front, alors qu'une occurrence dans le corps peut
 * n'être qu'une mention de passage.
 *
 * Un article est :
 *   - rattaché à un axe si son score sur cet axe ≥ SEUIL_AXE ;
 *   - conservé si son score total ≥ SEUIL_MIN ;
 *   - écarté si un terme d'exclusion apparaît (emploi, pub, homonymes).
 *
 * Régler la sensibilité : baisser SEUIL_MIN fait remonter plus de bruit,
 * le monter resserre sur les articles franchement dans le sujet.
 */

// ---------------------------------------------------------------------------
// Tout ce bloc est GÉNÉRÉ depuis config/lexique.yaml au moment du build.
// Ne pas l'éditer ici : éditer le YAML puis lancer
//   docker compose run --rm builder
// ---------------------------------------------------------------------------

const SEUIL_AXE = /* @@SEUIL_AXE@@ */ 3;
const SEUIL_MIN = /* @@SEUIL_MIN@@ */ 3;

const POIDS = /* @@POIDS@@ */ {};
const BONUS_TITRE = /* @@BONUS_TITRE@@ */ 2;

const LIBELLE_CERCLE = { coeur: 'cœur', peripherie: 'périphérie', signaux: 'signal faible' };

const AXES = /* @@AXES@@ */ {};

const EXCLUSIONS = /* @@EXCLUSIONS@@ */ [];

const MARQUEURS_UE = /* @@MARQUEURS_UE@@ */ [];
const AXES_ANCRAGE_UE = new Set(/* @@AXES_ANCRAGE_UE@@ */ []);
const MALUS_HORS_UE = /* @@MALUS_HORS_UE@@ */ 4;

// --- Normalisation et détection -------------------------------------------

/** Minuscules, sans accents : la comparaison se fait sur cette forme. */
const norm = (s) =>
  String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Cherche un terme entouré de non-alphanumériques, pour éviter qu'« ANSSI »
 * ne se déclenche à l'intérieur d'un autre mot. Les regex sont mémoïsées :
 * on teste ~150 termes contre chaque article.
 */
const RE_CACHE = new Map();
function contains(haystack, term) {
  let re = RE_CACHE.get(term);
  if (!re) {
    re = new RegExp(`(^|[^a-z0-9])${escapeRe(norm(term))}([^a-z0-9]|$)`);
    RE_CACHE.set(term, re);
  }
  return re.test(haystack);
}

// --- Traitement ------------------------------------------------------------

const retenus = [];
let ecartesExclusion = 0;
let ecartesScore = 0;

for (const item of $input.all()) {
  const article = item.json;

  // Item technique émis par la collecte quand aucun article n'est retenu :
  // il ne porte que le bilan des flux.
  if (article._empty || !article.title) continue;

  const titreNorm = norm(article.title);
  const texteNorm = norm(`${article.title} ${article.excerpt}`);

  if (EXCLUSIONS.some((t) => contains(texteNorm, t))) {
    ecartesExclusion += 1;
    continue;
  }

  let scoreTotal = 0;
  let signalFaible = false;
  const scoreParAxe = {};
  const themes = [];
  const motsCles = new Set();
  const explication = [];

  const ancreUE = MARQUEURS_UE.some((t) => contains(texteNorm, t));

  for (const [axe, cercles] of Object.entries(AXES)) {
    let scoreAxe = 0;

    for (const [cercle, termes] of Object.entries(cercles)) {
      for (const terme of termes) {
        if (!contains(texteNorm, terme)) continue;

        const dansTitre = contains(titreNorm, terme);
        const points = dansTitre ? POIDS[cercle] * BONUS_TITRE : POIDS[cercle];

        scoreAxe += points;
        motsCles.add(terme);
        explication.push(
          `${terme} (${LIBELLE_CERCLE[cercle]}${dansTitre ? `, titre ×${BONUS_TITRE}` : ''}) +${points}`,
        );
        if (cercle === 'signaux') signalFaible = true;
      }
    }

    // Sujet mondial revendiqué hors UE : on retire le bonus de titre qui
    // l'a fait monter, sans descendre sous zéro.
    if (scoreAxe > 0 && AXES_ANCRAGE_UE.has(axe) && !ancreUE) {
      const avant = scoreAxe;
      scoreAxe = Math.max(0, scoreAxe - MALUS_HORS_UE);
      explication.push(`hors périmètre UE −${avant - scoreAxe}`);
    }

    scoreParAxe[axe] = scoreAxe;
    if (scoreAxe >= SEUIL_AXE) themes.push(axe);
    scoreTotal += scoreAxe;
  }

  if (scoreTotal < SEUIL_MIN) {
    ecartesScore += 1;
    continue;
  }

  retenus.push({
    json: {
      ...article,
      score: scoreTotal,
      themes: themes.length ? themes : ['Transverse'],
      keywords: [...motsCles],
      weakSignal: signalFaible,
      scoreDetail: scoreParAxe,
      scoreExplain: explication,
    },
  });
}

// Les articles les plus pertinents en premier : utile à la lecture des
// exécutions et à l'ordre d'insertion en base.
retenus.sort((a, b) => b.json.score - a.json.score);

console.log(
  `Scoring : ${retenus.length} retenus · ${ecartesScore} sous le seuil (${SEUIL_MIN}) · ${ecartesExclusion} exclus`,
);

return retenus;
