/**
 * DATABASE INSERT PREPARATION
 *
 * Flattens each article into columns ready for the `articles` table.
 * Arrays (themes, keywords, score_explain) are serialised as Postgres
 * literals, and score_detail as JSON: the Postgres node passes values
 * through as is, so this is where they get formatted.
 *
 * Deduplication is handled by the UNIQUE constraint on dedup_key:
 * re-inserting a known article creates no duplicate and does not overwrite
 * its reading status (ON CONFLICT DO NOTHING in the query).
 */

/**
 * Serialises a JS array as a Postgres literal: {"a","b"}.
 * Inner quotes and backslashes are escaped.
 */
function toPgArray(values) {
  const items = (values ?? [])
    .map((v) => String(v ?? '').trim())
    .filter(Boolean)
    .map((v) => `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);
  return `{${items.join(',')}}`;
}

/** Postgres rejects null bytes, which some badly encoded feeds slip in. */
const clean = (s, max) => {
  const t = String(s ?? '').replace(/\0/g, '').trim();
  return max ? t.slice(0, max) : t;
};

return $input.all().map(({ json: article }) => ({
  json: {
    dedup_key:     clean(article.dedupKey, 500),
    title_vocab:   clean(article.titleVocab, 500),
    title:         clean(article.title, 1000),
    url:           clean(article.url, 2000),
    domain:        clean(article.domain, 255),
    source:        clean(article.source, 255),
    author:        clean(article.author, 255),
    feed:          clean(article.feed, 255),
    category:      clean(article.category, 100),
    source_type:   clean(article.sourceType, 100),
    excerpt:       clean(article.excerpt, 2000),
    published_at:  article.date,
    score:         Number(article.score) || 0,
    weak_signal:   Boolean(article.weakSignal),
    themes:        toPgArray(article.themes),
    keywords:      toPgArray(article.keywords),
    score_detail:  JSON.stringify(article.scoreDetail ?? {}),
    score_explain: toPgArray(article.scoreExplain),
  },
}));
