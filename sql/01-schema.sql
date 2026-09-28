-- ---------------------------------------------------------------------------
-- Base de veille — exécutée automatiquement à la création du volume.
--
-- Cette base est distincte de celle de n8n : les données de veille ne
-- doivent pas cohabiter avec l'état interne de l'outil (workflows,
-- credentials, historique d'exécutions).
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS articles (
    id              BIGSERIAL PRIMARY KEY,

    -- Clé de dédoublonnage (titre normalisé). L'unicité est garantie ici
    -- plutôt que par un historique glissant côté n8n : une contrainte de
    -- base ne peut pas dériver ni être purgée par erreur.
    dedup_key       TEXT        NOT NULL UNIQUE,

    -- Vocabulaire significatif du titre, trié. Sert à regrouper les reprises
    -- d'un même sujet par plusieurs médias (voir v_sujets_repris). Ce n'est
    -- PAS une clé de dédoublonnage : la fusion automatique a été écartée,
    -- aucun seuil ne distinguant « la France transpose NIS2 » de
    -- « l'Allemagne transpose NIS2 » sans faire disparaître d'information.
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

    -- Date de publication déclarée par le flux.
    published_at    TIMESTAMPTZ,
    -- Date de collecte : published_at peut être absente ou fantaisiste.
    collected_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

    score           INTEGER     NOT NULL DEFAULT 0,
    weak_signal     BOOLEAN     NOT NULL DEFAULT false,

    -- Un article peut relever de plusieurs axes.
    themes          TEXT[]      NOT NULL DEFAULT '{}',
    keywords        TEXT[]      NOT NULL DEFAULT '{}',

    -- Score par axe : {"NIS2": 6, "CRA": 0, ...}
    score_detail    JSONB       NOT NULL DEFAULT '{}'::jsonb,
    -- Détail du calcul, pour comprendre pourquoi l'article est remonté.
    score_explain   TEXT[]      NOT NULL DEFAULT '{}',

    -- Suivi de lecture, équivalent de la colonne Statut de Notion.
    status          TEXT        NOT NULL DEFAULT 'À évaluer'
                                CHECK (status IN ('À évaluer', 'Retenu', 'Écarté', 'Archivé')),
    notes           TEXT
);

-- Tri par défaut de l'inbox : les plus pertinents d'abord.
CREATE INDEX IF NOT EXISTS idx_articles_score      ON articles (score DESC, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_articles_published  ON articles (published_at DESC);
CREATE INDEX IF NOT EXISTS idx_articles_status     ON articles (status);
CREATE INDEX IF NOT EXISTS idx_articles_themes     ON articles USING GIN (themes);
CREATE INDEX IF NOT EXISTS idx_articles_keywords   ON articles USING GIN (keywords);

-- ---------------------------------------------------------------------------
-- Journal de collecte : sans lui, un flux mort depuis trois semaines passe
-- inaperçu. Une ligne par flux et par exécution.
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
