-- ---------------------------------------------------------------------------
-- Vues d'analyse — prêtes à l'emploi dans Metabase.
-- Elles apparaissent comme des tables : aucune requête à écrire pour
-- construire un premier tableau de bord.
-- ---------------------------------------------------------------------------

-- Inbox : ce qu'il reste à trier, le plus pertinent d'abord.
CREATE OR REPLACE VIEW v_inbox AS
SELECT id, published_at, score, themes, title, source, domain, url, weak_signal
FROM   articles
WHERE  status = 'À évaluer'
ORDER  BY score DESC, published_at DESC;

-- Volume par jour et par axe : révèle les pics d'actualité réglementaire.
CREATE OR REPLACE VIEW v_volume_par_jour AS
SELECT date_trunc('day', published_at)::date AS jour,
       theme,
       count(*)                              AS articles,
       round(avg(score), 1)                  AS score_moyen
FROM   articles, unnest(themes) AS theme
WHERE  published_at IS NOT NULL
GROUP  BY jour, theme
ORDER  BY jour DESC, articles DESC;

-- Sources les plus productives, et leur qualité moyenne.
-- Une source au score moyen bas produit du volume sans pertinence.
CREATE OR REPLACE VIEW v_sources AS
SELECT feed,
       source_type,
       count(*)                                          AS articles,
       round(avg(score), 1)                              AS score_moyen,
       count(*) FILTER (WHERE score >= 8)                AS articles_forts,
       max(published_at)                                 AS dernier_article
FROM   articles
GROUP  BY feed, source_type
ORDER  BY articles DESC;

-- Mots-clés les plus fréquents : montre quels termes du lexique
-- travaillent réellement, et lesquels ne se déclenchent jamais.
CREATE OR REPLACE VIEW v_mots_cles AS
SELECT mot,
       count(*)             AS occurrences,
       round(avg(score), 1) AS score_moyen
FROM   articles, unnest(keywords) AS mot
GROUP  BY mot
ORDER  BY occurrences DESC;

-- Santé des flux sur 7 jours : un flux à 0 succès est à retirer.
CREATE OR REPLACE VIEW v_sante_flux AS
SELECT feed,
       count(*)                                  AS executions,
       count(*) FILTER (WHERE status = 'ok')     AS succes,
       count(*) FILTER (WHERE status = 'échec')  AS echecs,
       sum(items_kept)                           AS articles_produits,
       max(run_at)                               AS derniere_execution,
       (array_agg(detail ORDER BY run_at DESC)
          FILTER (WHERE status = 'échec'))[1]    AS derniere_erreur
FROM   feed_runs
WHERE  run_at > now() - interval '7 days'
GROUP  BY feed
ORDER  BY echecs DESC, articles_produits DESC;

-- Répartition par statut : avancement du tri.
CREATE OR REPLACE VIEW v_avancement AS
SELECT status,
       count(*)                                    AS articles,
       round(100.0 * count(*) / NULLIF(sum(count(*)) OVER (), 0), 1) AS pourcentage
FROM   articles
GROUP  BY status
ORDER  BY articles DESC;

-- Sujets repris par plusieurs médias.
--
-- Deux articles sont rapprochés quand leurs titres partagent au moins 60 %
-- de leur vocabulaire significatif. Le regroupement est indicatif : à la
-- lecture de décider s'il s'agit du même sujet, d'un angle différent ou de
-- deux pays distincts. Rien n'est supprimé automatiquement.
CREATE OR REPLACE VIEW v_sujets_repris AS
WITH paires AS (
    SELECT a.id                AS id_a,
           b.id                AS id_b,
           a.title             AS titre_a,
           b.title             AS titre_b,
           a.source            AS source_a,
           b.source            AS source_b,
           greatest(a.score, b.score) AS score_max,
           a.published_at      AS date_a,
           cardinality(ARRAY(SELECT unnest(string_to_array(a.title_vocab, ' '))
                             INTERSECT
                             SELECT unnest(string_to_array(b.title_vocab, ' ')))) AS communs,
           least(cardinality(string_to_array(a.title_vocab, ' ')),
                 cardinality(string_to_array(b.title_vocab, ' '))) AS base
    FROM   articles a
    JOIN   articles b ON a.id < b.id
    WHERE  a.title_vocab IS NOT NULL AND b.title_vocab IS NOT NULL
      AND  a.published_at > now() - interval '14 days'
      AND  b.published_at > now() - interval '14 days'
)
SELECT id_a, id_b, titre_a, titre_b, source_a, source_b, score_max,
       round(100.0 * communs / NULLIF(base, 0)) AS recouvrement_pct
FROM   paires
WHERE  base >= 3
  AND  communs >= 0.6 * base
ORDER  BY recouvrement_pct DESC, score_max DESC;
