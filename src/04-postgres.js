/**
 * PRÉPARATION DE L'INSERTION EN BASE
 *
 * Aplatit chaque article en colonnes prêtes pour la table `articles`.
 * Les tableaux (themes, keywords, score_explain) sont sérialisés au format
 * littéral Postgres, et score_detail en JSON : le nœud Postgres transmet
 * les valeurs telles quelles, c'est donc ici qu'on les met en forme.
 *
 * Le dédoublonnage est assuré par la contrainte UNIQUE sur dedup_key :
 * réinsérer un article connu ne crée pas de doublon et n'écrase pas le
 * statut de lecture (ON CONFLICT DO NOTHING côté requête).
 */

/**
 * Sérialise un tableau JS en littéral Postgres : {"a","b"}.
 * Les guillemets et antislashs internes sont échappés.
 */
function toPgArray(values) {
  const items = (values ?? [])
    .map((v) => String(v ?? '').trim())
    .filter(Boolean)
    .map((v) => `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);
  return `{${items.join(',')}}`;
}

/** Postgres refuse les octets nuls, que certains flux mal encodés glissent. */
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
