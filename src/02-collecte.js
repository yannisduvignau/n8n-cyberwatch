/**
 * COLLECTION + NORMALISATION
 *
 * "Run Once for All Items" mode: we receive the N sources at once and
 * download the feeds ourselves rather than going through the RSS Read node.
 *
 * Why:
 *   - the article → source link is guaranteed (we loop source by source),
 *     whereas pairedItem gets lost when a node emits N outputs for one
 *     input;
 *   - a dead feed (403, DNS, timeout) is isolated in its own try/catch and
 *     no longer breaks the whole execution;
 *   - one node to maintain instead of two.
 *
 * Output: one item per kept article, deduplicated within the batch.
 */

// Values injected from config/workflow.yaml at build time.
const MAX_AGE_DAYS = /* @@AGE_MAX_JOURS@@ */ 7;
const FETCH_TIMEOUT_MS = /* @@TIMEOUT_MS@@ */ 15000;
const CONCURRENCY = /* @@CONCURRENCE@@ */ 6;
const MAX_ITEMS_PER_FEED = /* @@MAX_ARTICLES_PAR_FLUX@@ */ 40;
// Hard cap on a feed's body: MAX_ITEMS_PER_FEED only slices AFTER parsing, so
// without this a hostile or spoofed feed could return a huge body and exhaust
// the worker's memory/CPU before we ever count entries.
const MAX_BODY_BYTES = /* @@TAILLE_MAX_FLUX@@ */ 8 * 1024 * 1024;

const cutoff = Date.now() - MAX_AGE_DAYS * 24 * 3600 * 1000;

// --- Text utilities --------------------------------------------------------

/** Strips tags and normalises whitespace. */
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

/** Lowercase, no accents or punctuation — basis of the deduplication keys. */
const slug = (s) =>
  String(s ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/**
 * FR + EN stop words, removed from the story fingerprint: they vary from
 * one outlet to another without saying anything about the substance.
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
 * Significant vocabulary of a title: long words, stop words removed, sorted.
 *
 * Used to GROUP coverage of the same story by several outlets, not to
 * remove it. An attempt at automatic deduplication on this basis was ruled
 * out: no similarity threshold separated "France transposes NIS2" from
 * "Germany transposes NIS2" without letting real duplicates through. In
 * regulatory monitoring, a wrong merge makes information disappear — we
 * prefer to flag and let the reader decide.
 *
 * The v_sujets_repris view relies on this field.
 */
function vocabulaireTitre(titre) {
  const mots = slug(titre)
    .split(' ')
    .filter((m) => m.length >= LONGUEUR_MOT_MIN && !MOTS_VIDES.has(m));

  if (mots.length < 3) return '';
  return [...new Set(mots)].sort().join(' ');
}

/**
 * Cleans a URL: follows the Google redirect, strips tracking and the anchor.
 * Returns the original URL if it cannot be parsed.
 */
function cleanUrl(raw) {
  try {
    let u = new URL(String(raw).trim());
    // Google Alerts / News wrap the real target in ?url=
    const wrapped = u.searchParams.get('url');
    if (u.hostname.includes('google.') && wrapped) u = new URL(wrapped);
    // Only http(s) links belong in a feed. A feed-supplied javascript:/data:
    // URL parses fine but is useless downstream and breaks the Discord embed;
    // drop it rather than store or forward it.
    if (!/^https?:$/.test(u.protocol)) return '';
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
// Deliberately minimal: Code nodes have no XML parser, and the fields we
// care about are few and stable.

const TAG_CACHE = new Map();
function tagRe(tag) {
  if (!TAG_CACHE.has(tag)) {
    TAG_CACHE.set(tag, new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i'));
  }
  return TAG_CACHE.get(tag);
}

/** Content of the first <tag> found, with CDATA resolved. */
function tagText(xml, tag) {
  const m = xml.match(tagRe(tag));
  return m ? stripHtml(m[1]) : '';
}

/** Link of an entry: <link>text</link> (RSS) or <link href="…"/> (Atom). */
function entryLink(xml) {
  const rss = xml.match(/<link(?:\s[^>]*)?>([\s\S]*?)<\/link>/i);
  if (rss && stripHtml(rss[1])) return stripHtml(rss[1]);
  const atomAlt = xml.match(/<link[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["']/i);
  if (atomAlt) return atomAlt[1];
  const atom = xml.match(/<link[^>]*href=["']([^"']+)["']/i);
  return atom ? atom[1] : '';
}

/**
 * Google News provides the real publisher in <source url="https://…">Name</source>.
 * The article link itself remains a news.google.com redirect that cannot be
 * resolved without getting past the consent wall: so here we only retrieve
 * the publisher's name and domain.
 */
function entrySource(xml) {
  const m = xml.match(/<source(?:\s[^>]*)?\burl=["']([^"']+)["'][^>]*>([\s\S]*?)<\/source>/i);
  if (!m) return null;
  let host = '';
  try {
    host = new URL(m[1]).hostname.replace(/^www\./, '');
  } catch { /* invalid publisher URL: keep the name only */ }
  return { name: stripHtml(m[2]), host };
}

/** Splits a feed into <item> (RSS) or <entry> (Atom) entries. */
function splitEntries(xml) {
  const items = xml.match(/<item(?:\s[^>]*)?>[\s\S]*?<\/item>/gi);
  if (items?.length) return items;
  return xml.match(/<entry(?:\s[^>]*)?>[\s\S]*?<\/entry>/gi) ?? [];
}

// --- Download --------------------------------------------------------------

/**
 * Fetches a feed and returns its raw entries.
 *
 * Uses `this.helpers.httpRequest`: the Code node sandbox does not expose
 * `fetch`; this is the HTTP client provided by n8n.
 *
 * Never throws: errors are returned in `error`, so that a dead feed does
 * not interrupt the collection of the others.
 */
async function fetchFeed(src) {
  try {
    const res = await this.helpers.httpRequest({
      url: src.url,
      method: 'GET',
      timeout: FETCH_TIMEOUT_MS,
      returnFullResponse: true,
      // Refuse an oversized body outright (defence against a feed that returns
      // hundreds of MB); the slice below is the belt to this suspenders.
      maxContentLength: MAX_BODY_BYTES,
      // Otherwise n8n tries to parse the XML and we lose the raw text.
      json: false,
      headers: {
        // Some servers return 403 without a credible User-Agent.
        'User-Agent': 'Mozilla/5.0 (compatible; VeilleBot/1.0; +https://n8n.io)',
        Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.8',
      },
    });

    if (res.statusCode < 200 || res.statusCode >= 300) {
      return { src, entries: [], error: `HTTP ${res.statusCode}` };
    }

    // Belt to the maxContentLength suspenders: some transports ignore the
    // limit, so bound the text before any regex scans it.
    const xml = String(res.body ?? '').slice(0, MAX_BODY_BYTES);
    return { src, entries: splitEntries(xml).slice(0, MAX_ITEMS_PER_FEED), error: null };
  } catch (e) {
    // httpRequest wraps the HTTP status in different fields depending on the
    // kind of failure (network, timeout, error code).
    const statut = e.statusCode ?? e.httpCode ?? e.cause?.statusCode;
    const raison = statut ? `HTTP ${statut}` : (e.message ?? 'unknown error');
    return { src, entries: [], error: String(raison).slice(0, 200) };
  }
}

/** Runs `task` on each element, with at most `limit` in flight at once. */
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

// --- Processing ------------------------------------------------------------

const sources = $input.all().map((i) => i.json);
// fetchFeed relies on this.helpers: pass it the node's context.
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

    // Date: RSS uses pubDate, Atom published/updated.
    const rawDate = tagText(raw, 'pubDate') || tagText(raw, 'published') || tagText(raw, 'updated');
    const date = rawDate ? new Date(rawDate) : null;
    const dateValid = date && !Number.isNaN(date.getTime());
    if (dateValid && date.getTime() < cutoff) continue;

    const url = cleanUrl(link);
    // cleanUrl returns '' for a non-http(s) scheme: no usable link, skip.
    if (!url) continue;
    let domain = '';
    try {
      domain = new URL(url).hostname.replace(/^www\./, '');
    } catch { /* unparsable URL: domain left empty */ }

    let title = tagText(raw, 'title') || '(sans titre)';

    // Google News: the title is suffixed with "— Outlet" and the domain is
    // the redirect's. Restore the bare title and the real publisher.
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

    // Two strict keys: the URL catches the same page republished, the title
    // the same article under different URLs. We go no further: coverage of
    // a story by another outlet is flagged, not removed (see
    // vocabulaireTitre and the v_sujets_repris view).
    const urlKey = slug(url.replace(/^https?:\/\//, '').replace(/\/$/, ''));
    const titleKey = slug(title).slice(0, 90);
    if (!titleKey) continue;
    if (seen.has(urlKey) || seen.has(titleKey)) continue;
    seen.add(urlKey);
    seen.add(titleKey);

    // Google News copies the title into <description>: an excerpt that only
    // repeats the title adds nothing, so leave it empty.
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
      // Title vocabulary: lets us group coverage of the same story after the
      // fact, without ever removing it automatically.
      titleVocab: vocabulaireTitre(title),
    });
    kept += 1;
  }

  feedReport.push({
    feed: src.name, status: 'ok', detail: `${entries.length} entries`,
    found: entries.length, kept,
  });
}

// Log visible in the node's "Logs" tab: spot a dead feed without opening
// every execution.
const failed = feedReport.filter((f) => f.status === 'échec');
console.log(`Feeds polled: ${feeds.length} · failed: ${failed.length} · articles kept: ${articles.length}`);
for (const f of failed) console.warn(`  ✗ ${f.feed} — ${f.detail}`);

// The per-feed report travels on the first item, under a technical key
// that the "Préparer le journal" node reads back. The following nodes
// ignore it: they only read the article fields.
const out = articles.map((json) => ({ json }));
if (out.length) {
  out[0].json._feedReport = feedReport;
} else {
  // No article kept: still emit an item carrying the report, otherwise a
  // cycle with no results would leave no trace.
  out.push({ json: { _feedReport: feedReport, _empty: true } });
}
return out;
