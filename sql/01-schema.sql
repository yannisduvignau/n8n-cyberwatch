-- ---------------------------------------------------------------------------
-- Monitoring database — run automatically when the volume is created.
--
-- This database is separate from n8n's: monitoring data must not live
-- alongside the tool's internal state (workflows, credentials, execution
-- history).
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS articles (
    id              BIGSERIAL PRIMARY KEY,

    -- Deduplication key (normalised title). Uniqueness is enforced here
    -- rather than by a sliding history on the n8n side: a database
    -- constraint cannot drift or be purged by mistake.
    dedup_key       TEXT        NOT NULL UNIQUE,

    -- Significant vocabulary of the title, sorted. Used to group coverage of
    -- the same story by several outlets (see v_sujets_repris). It is NOT a
    -- deduplication key: automatic merging was ruled out, as no threshold
    -- told "France transposes NIS2" apart from "Germany transposes NIS2"
    -- without making information disappear.
    title_vocab     TEXT,

    title           TEXT        NOT NULL,
    url             TEXT        NOT NULL,
    domain          TEXT,
    source          TEXT,
    author          TEXT,
    feed            TEXT,
    category        TEXT,
    source_type     TEXT,
    excerpt         TEXT,

    -- Publication date declared by the feed.
    published_at    TIMESTAMPTZ,
    -- Collection date: published_at may be missing or bogus.
    collected_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

    score           INTEGER     NOT NULL DEFAULT 0,
    weak_signal     BOOLEAN     NOT NULL DEFAULT false,

    -- An article can belong to several topics.
    themes          TEXT[]      NOT NULL DEFAULT '{}',
    keywords        TEXT[]      NOT NULL DEFAULT '{}',

    -- Score per topic: {"NIS2": 6, "CRA": 0, ...}
    score_detail    JSONB       NOT NULL DEFAULT '{}'::jsonb,
    -- Breakdown of the computation, to understand why the article surfaced.
    score_explain   TEXT[]      NOT NULL DEFAULT '{}',

    -- Reading progress, equivalent to Notion's Status column.
    status          TEXT        NOT NULL DEFAULT 'À évaluer'
                                CHECK (status IN ('À évaluer', 'Retenu', 'Écarté', 'Archivé')),
    notes           TEXT
);

-- Default inbox ordering: most relevant first.
CREATE INDEX IF NOT EXISTS idx_articles_score      ON articles (score DESC, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_articles_published  ON articles (published_at DESC);
CREATE INDEX IF NOT EXISTS idx_articles_status     ON articles (status);
CREATE INDEX IF NOT EXISTS idx_articles_themes     ON articles USING GIN (themes);
CREATE INDEX IF NOT EXISTS idx_articles_keywords   ON articles USING GIN (keywords);

-- ---------------------------------------------------------------------------
-- Collection log: without it, a feed that has been dead for three weeks
-- goes unnoticed. One row per feed and per execution.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS feed_runs (
    id            BIGSERIAL PRIMARY KEY,
    run_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    feed          TEXT        NOT NULL,
    status        TEXT        NOT NULL CHECK (status IN ('ok', 'échec')),
    detail        TEXT,
    items_found   INTEGER     NOT NULL DEFAULT 0,
    items_kept    INTEGER     NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_feed_runs_run_at ON feed_runs (run_at DESC);
CREATE INDEX IF NOT EXISTS idx_feed_runs_feed   ON feed_runs (feed, run_at DESC);
