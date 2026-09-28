/**
 * COLLECTE + NORMALISATION
 *
 * Mode « Run Once for All Items » : on reçoit les N sources d'un coup et on
 * télécharge les flux nous-mêmes plutôt que de passer par le nœud RSS Read.
 *
 * Pourquoi ce choix :
 *   - le rattachement article → source est garanti (on boucle source par
 *     source), là où pairedItem se perd quand un nœud émet N sorties pour
 *     une entrée ;
 *   - un flux mort (403, DNS, timeout) est isolé dans son try/catch et ne
 *     casse plus l'exécution entière ;
 *   - un seul nœud à maintenir au lieu de deux.
 *
 * Sortie : un item par article retenu, dédoublonné au sein du lot.
 */

// Valeurs injectées depuis config/workflow.yaml au build.
const MAX_AGE_DAYS = /* @@AGE_MAX_JOURS@@ */ 7;
const FETCH_TIMEOUT_MS = /* @@TIMEOUT_MS@@ */ 15000;
const CONCURRENCY = /* @@CONCURRENCE@@ */ 6;
const MAX_ITEMS_PER_FEED = /* @@MAX_ARTICLES_PAR_FLUX@@ */ 40;

const cutoff = Date.now() - MAX_AGE_DAYS * 24 * 3600 * 1000;

// --- Utilitaires texte -----------------------------------------------------

/** Retire les balises et normalise les espaces. */
const stripHtml = (s) =>
  String(s ?? '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#3[49];/g, "'")
    .replace(/\s+/g, ' ')
    .trim();

/** Minuscules sans accents ni ponctuation — base des clés de dédoublonnage. */
const slug = (s) =>
  String(s ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/**
 * Mots vides FR + EN, retires de l'empreinte de sujet : ils varient d'un
 * media a l'autre sans rien dire du fond.
 */
const MOTS_VIDES = new Set([
  'le', 'la', 'les', 'un', 'une', 'des', 'du', 'de', 'au', 'aux', 'et', 'ou',
  'pour', 'par', 'sur', 'dans', 'avec', 'sans', 'sous', 'vers', 'chez', 'que',
  'qui', 'quoi', 'dont', 'est', 'sont', 'ete', 'son', 'ses', 'leur', 'leurs',
  'ce', 'cet', 'cette', 'ces', 'plus', 'moins', 'tout', 'tous', 'toute',
  'the', 'a', 'an', 'and', 'or', 'for', 'to', 'of', 'in', 'on', 'at', 'by',
  'with', 'from', 'as', 'is', 'are', 'was', 'were', 'be', 'been', 'its',
  'this', 'that', 'these', 'those', 'new', 'now', 'how', 'why', 'what',
]);

const LONGUEUR_MOT_MIN = 4;

/**
 * Vocabulaire significatif d'un titre : mots longs, hors mots vides, tries.
 *
 * Sert a REGROUPER les reprises d'un meme sujet par plusieurs medias, pas a
 * les supprimer. Une tentative de deduplication automatique sur cette base a
 * ete ecartee : aucun seuil de similarite ne separait « la France transpose
 * NIS2 » de « l'Allemagne transpose NIS2 » sans laisser passer de vrais
 * doublons. En veille reglementaire, fusionner a tort fait disparaitre une
 * information — on prefere signaler et laisser trancher.
 *
 * La vue v_sujets_repris s'appuie sur ce champ.
 */
function vocabulaireTitre(titre) {
  const mots = slug(titre)
    .split(' ')
    .filter((m) => m.length >= LONGUEUR_MOT_MIN && !MOTS_VIDES.has(m));

  if (mots.length < 3) return '';
  return [...new Set(mots)].sort().join(' ');
}

/**
 * Nettoie une URL : suit la redirection Google, retire le tracking et l'ancre.
 * Renvoie l'URL d'origine si elle est impossible à parser.
 */
function cleanUrl(raw) {
  try {
    let u = new URL(String(raw).trim());
    // Google Alerts / News encapsulent la vraie cible dans ?url=
    const wrapped = u.searchParams.get('url');
    if (u.hostname.includes('google.') && wrapped) u = new URL(wrapped);
    for (const k of [...u.searchParams.keys()]) {
      if (/^(utm_|ref_|mc_)/.test(k) || ['fbclid', 'gclid', 'igshid', 'at_medium', 'at_campaign'].includes(k)) {
        u.searchParams.delete(k);
      }
    }
    u.hash = '';
    return u.toString();
  } catch {
    return String(raw ?? '');
  }
}

// --- Parsing RSS / Atom ----------------------------------------------------
// Volontairement minimaliste : les nœuds Code n'ont pas de parseur XML, et
// les champs qui nous intéressent sont peu nombreux et stables.

const TAG_CACHE = new Map();
function tagRe(tag) {
  if (!TAG_CACHE.has(tag)) {
    TAG_CACHE.set(tag, new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i'));
  }
  return TAG_CACHE.get(tag);
}

/** Contenu du premier <tag> rencontré, CDATA résolu. */
function tagText(xml, tag) {
  const m = xml.match(tagRe(tag));
  return m ? stripHtml(m[1]) : '';
}

/** Lien d'une entrée : <link>texte</link> (RSS) ou <link href="…"/> (Atom). */
function entryLink(xml) {
  const rss = xml.match(/<link(?:\s[^>]*)?>([\s\S]*?)<\/link>/i);
  if (rss && stripHtml(rss[1])) return stripHtml(rss[1]);
  const atomAlt = xml.match(/<link[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["']/i);
  if (atomAlt) return atomAlt[1];
  const atom = xml.match(/<link[^>]*href=["']([^"']+)["']/i);
  return atom ? atom[1] : '';
}

/**
 * Google News fournit l'éditeur réel dans <source url="https://…">Nom</source>.
 * Le lien de l'article, lui, reste un renvoi news.google.com impossible à
 * résoudre sans franchir le mur de consentement : on se contente donc de
 * récupérer ici le nom et le domaine de l'éditeur.
 */
function entrySource(xml) {
  const m = xml.match(/<source(?:\s[^>]*)?\burl=["']([^"']+)["'][^>]*>([\s\S]*?)<\/source>/i);
  if (!m) return null;
  let host = '';
  try {
    host = new URL(m[1]).hostname.replace(/^www\./, '');
  } catch { /* url d'éditeur invalide : on garde le nom seul */ }
  return { name: stripHtml(m[2]), host };
}

/** Découpe un flux en entrées <item> (RSS) ou <entry> (Atom). */
function splitEntries(xml) {
  const items = xml.match(/<item(?:\s[^>]*)?>[\s\S]*?<\/item>/gi);
  if (items?.length) return items;
  return xml.match(/<entry(?:\s[^>]*)?>[\s\S]*?<\/entry>/gi) ?? [];
}

// --- Téléchargement --------------------------------------------------------

/**
 * Récupère un flux et renvoie ses entrées brutes.
 *
 * Utilise `this.helpers.httpRequest` : le sandbox des nœuds Code n'expose
 * pas `fetch`, c'est le client HTTP fourni par n8n.
 *
 * Ne lève jamais : les erreurs sont retournées dans `error`, pour qu'un
 * flux mort n'interrompe pas la collecte des autres.
 */
async function fetchFeed(src) {
  try {
    const res = await this.helpers.httpRequest({
      url: src.url,
      method: 'GET',
      timeout: FETCH_TIMEOUT_MS,
      returnFullResponse: true,
      // Sans quoi n8n tente de parser le XML et nous prive du texte brut.
      json: false,
      headers: {
        // Certains serveurs renvoient 403 sans User-Agent crédible.
        'User-Agent': 'Mozilla/5.0 (compatible; VeilleBot/1.0; +https://n8n.io)',
        Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.8',
      },
    });

    if (res.statusCode < 200 || res.statusCode >= 300) {
      return { src, entries: [], error: `HTTP ${res.statusCode}` };
    }

    const xml = String(res.body ?? '');
    return { src, entries: splitEntries(xml).slice(0, MAX_ITEMS_PER_FEED), error: null };
  } catch (e) {
    // httpRequest enveloppe le statut HTTP dans différents champs selon le
    // type d'échec (réseau, timeout, code d'erreur).
    const statut = e.statusCode ?? e.httpCode ?? e.cause?.statusCode;
    const raison = statut ? `HTTP ${statut}` : (e.message ?? 'erreur inconnue');
    return { src, entries: [], error: String(raison).slice(0, 200) };
  }
}

/** Exécute `task` sur chaque élément, `limit` en vol à la fois. */
async function mapPool(items, limit, task) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await task(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

// --- Traitement ------------------------------------------------------------

const sources = $input.all().map((i) => i.json);
// fetchFeed s'appuie sur this.helpers : on lui transmet le contexte du nœud.
const feeds = await mapPool(sources, CONCURRENCY, (src) => fetchFeed.call(this, src));

const seen = new Set();
const articles = [];
const feedReport = [];

for (const { src, entries, error } of feeds) {
  if (error) {
    feedReport.push({ feed: src.name, status: 'échec', detail: error, found: 0, kept: 0 });
    continue;
  }

  let kept = 0;
  for (const raw of entries) {
    const link = entryLink(raw);
    if (!link) continue;

    // Date : RSS utilise pubDate, Atom published/updated.
    const rawDate = tagText(raw, 'pubDate') || tagText(raw, 'published') || tagText(raw, 'updated');
    const date = rawDate ? new Date(rawDate) : null;
    const dateValid = date && !Number.isNaN(date.getTime());
    if (dateValid && date.getTime() < cutoff) continue;

    const url = cleanUrl(link);
    let domain = '';
    try {
      domain = new URL(url).hostname.replace(/^www\./, '');
    } catch { /* URL non parsable : domaine laissé vide */ }

    let title = tagText(raw, 'title') || '(sans titre)';

    // Google News : le titre est suffixé « — Média » et le domaine est celui
    // de la redirection. On restitue le titre nu et le vrai éditeur.
    let publisher = '';
    if (src.type === 'Google News' || domain.includes('news.google.')) {
      const m = title.match(/^(.*\S)\s+[-–|]\s+([^-–|]{2,60})$/);
      if (m) {
        title = m[1].trim();
        publisher = m[2].trim();
      }
      const gn = entrySource(raw);
      if (gn) {
        publisher = gn.name || publisher;
        if (gn.host) domain = gn.host;
      }
    }

    // Deux clés strictes : l'URL attrape la même page rediffusée, le titre
    // le même article sous des URLs différentes. On ne va pas au-delà : la
    // reprise d'un sujet par un autre média est signalée, pas supprimée
    // (voir vocabulaireTitre et la vue v_sujets_repris).
    const urlKey = slug(url.replace(/^https?:\/\//, '').replace(/\/$/, ''));
    const titleKey = slug(title).slice(0, 90);
    if (!titleKey) continue;
    if (seen.has(urlKey) || seen.has(titleKey)) continue;
    seen.add(urlKey);
    seen.add(titleKey);

    // Google News recopie le titre dans <description> : un extrait qui ne
    // fait que répéter le titre n'apporte rien, on le laisse vide.
    let excerpt = stripHtml(
      tagText(raw, 'description') || tagText(raw, 'summary') || tagText(raw, 'content'),
    ).slice(0, 500);
    if (slug(excerpt).startsWith(slug(title).slice(0, 60))) excerpt = '';

    articles.push({
      title,
      url,
      domain,
      source: publisher || src.name || domain,
      author: tagText(raw, 'dc:creator') || tagText(raw, 'author') || tagText(raw, 'name'),
      feed: src.name,
      category: src.category ?? 'Non classé',
      sourceType: src.type ?? 'Inconnu',
      date: dateValid ? date.toISOString() : new Date().toISOString(),
      excerpt,
      dedupKey: titleKey,
      // Vocabulaire du titre : permet de regrouper a posteriori les reprises
      // d'un meme sujet, sans jamais les supprimer automatiquement.
      titleVocab: vocabulaireTitre(title),
    });
    kept += 1;
  }

  feedReport.push({
    feed: src.name, status: 'ok', detail: `${entries.length} entrées`,
    found: entries.length, kept,
  });
}

// Journal consultable dans l'onglet « Logs » du nœud : permet de repérer
// un flux mort sans ouvrir chaque exécution.
const failed = feedReport.filter((f) => f.status === 'échec');
console.log(`Flux interrogés : ${feeds.length} · en échec : ${failed.length} · articles retenus : ${articles.length}`);
for (const f of failed) console.warn(`  ✗ ${f.feed} — ${f.detail}`);

// Le bilan par flux voyage sur le premier item, sous une clé technique que
// le nœud « Journal de collecte » vient relire. Les nœuds suivants
// l'ignorent : ils ne lisent que les champs d'article.
const out = articles.map((json) => ({ json }));
if (out.length) {
  out[0].json._feedReport = feedReport;
} else {
  // Aucun article retenu : on émet tout de même un item porteur du bilan,
  // sinon un cycle sans résultat ne laisserait aucune trace.
  out.push({ json: { _feedReport: feedReport, _empty: true } });
}
return out;
