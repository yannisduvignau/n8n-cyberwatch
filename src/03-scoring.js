/**
 * SCORING PER TOPIC
 *
 * Each monitoring topic has a lexicon made of three concentric circles:
 *
 *   coeur       the term names the subject itself             3 pts
 *   peripherie  the term revolves around the subject          2 pts
 *   signaux     weak hint, to be confirmed by the context     1 pt
 *
 * A term found in the title counts double: a subject announced in the
 * title is being addressed head-on, whereas an occurrence in the body may
 * be a passing mention.
 *
 * An article is:
 *   - attached to a topic if its score on that topic ≥ SEUIL_AXE;
 *   - kept if its total score ≥ SEUIL_MIN;
 *   - discarded if an exclusion term appears (jobs, ads, homonyms).
 *
 * Tuning sensitivity: lowering SEUIL_MIN lets more noise through, raising
 * it narrows down to articles squarely on topic.
 */

// ---------------------------------------------------------------------------
// This whole block is GENERATED from config/lexique.yaml at build time.
// Do not edit it here: edit the YAML then run
//   docker compose run --rm builder
// ---------------------------------------------------------------------------

const SEUIL_AXE = /* @@SEUIL_AXE@@ */ 3;
const SEUIL_MIN = /* @@SEUIL_MIN@@ */ 3;

const POIDS = /* @@POIDS@@ */ {};
const BONUS_TITRE = /* @@BONUS_TITRE@@ */ 2;

const LIBELLE_CERCLE = { coeur: 'core', peripherie: 'periphery', signaux: 'weak signal' };

const AXES = /* @@AXES@@ */ {};

const EXCLUSIONS = /* @@EXCLUSIONS@@ */ [];

const MARQUEURS_UE = /* @@MARQUEURS_UE@@ */ [];
const AXES_ANCRAGE_UE = new Set(/* @@AXES_ANCRAGE_UE@@ */ []);
const MALUS_HORS_UE = /* @@MALUS_HORS_UE@@ */ 4;

// --- Normalisation and matching --------------------------------------------

/** Lowercase, no accents: matching is done on this form. */
const norm = (s) =>
  String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Looks for a term surrounded by non-alphanumerics, so that "ANSSI" does
 * not fire inside another word. Regexes are memoised: ~150 terms are tested
 * against each article.
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

// --- Processing ------------------------------------------------------------

const retenus = [];
let ecartesExclusion = 0;
let ecartesScore = 0;

for (const item of $input.all()) {
  const article = item.json;

  // Technical item emitted by collection when no article is kept: it only
  // carries the feed report.
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
          `${terme} (${LIBELLE_CERCLE[cercle]}${dansTitre ? `, title ×${BONUS_TITRE}` : ''}) +${points}`,
        );
        if (cercle === 'signaux') signalFaible = true;
      }
    }

    // Global subject claimed outside the EU: subtract MALUS_HORS_UE from the
    // topic score, without going below zero.
    if (scoreAxe > 0 && AXES_ANCRAGE_UE.has(axe) && !ancreUE) {
      const avant = scoreAxe;
      scoreAxe = Math.max(0, scoreAxe - MALUS_HORS_UE);
      explication.push(`outside EU scope −${avant - scoreAxe}`);
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

// Most relevant articles first: helps when reading executions and sets the
// database insertion order.
retenus.sort((a, b) => b.json.score - a.json.score);

console.log(
  `Scoring: ${retenus.length} kept · ${ecartesScore} below threshold (${SEUIL_MIN}) · ${ecartesExclusion} excluded`,
);

return retenus;
