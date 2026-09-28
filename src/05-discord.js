/**
 * MESSAGE DISCORD
 *
 * Construit l'embed envoyé au salon d'équipe pour les articles à score élevé.
 * Le nœud suivant se contente de POSTer `payload` sur le webhook.
 *
 * Contraintes Discord respectées ici : titre 256 car., description 4096,
 * valeur de champ 1024, footer 2048.
 */

const COULEURS = {
  signalFaible: 0x2ecc71, // vert : à surveiller
  tresEleve:    0xe74c3c, // rouge : à lire en priorité
  eleve:        0x3498db, // bleu : lecture normale
};

const SEUIL_TRES_ELEVE = /* @@SEUIL_URGENT@@ */ 15;
const SEUIL_ALERTE = /* @@SEUIL_ALERTE@@ */ 8;

/** Tronque en coupant proprement, sans laisser de mot à moitié. */
function tronquer(texte, max) {
  const s = String(texte ?? '');
  if (s.length <= max) return s;
  const coupe = s.slice(0, max - 1);
  const espace = coupe.lastIndexOf(' ');
  return `${espace > max * 0.6 ? coupe.slice(0, espace) : coupe}…`;
}

const dateFr = (iso) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('fr-FR', {
    timeZone: 'Europe/Paris',
    dateStyle: 'medium',
    timeStyle: 'short',
  });
};

return $input.all().map(({ json: article }) => {
  const niveau =
    article.score >= SEUIL_TRES_ELEVE ? 'très élevé' : article.score >= SEUIL_ALERTE ? 'élevé' : 'modéré';

  const couleur = article.weakSignal
    ? COULEURS.signalFaible
    : article.score >= SEUIL_TRES_ELEVE
      ? COULEURS.tresEleve
      : COULEURS.eleve;

  // Répartition du score entre les axes, axes à zéro omis.
  const repartition = Object.entries(article.scoreDetail ?? {})
    .filter(([, v]) => v > 0)
    .map(([axe, v]) => `**${axe}** : ${v}`)
    .join(' · ');

  const detail = tronquer(
    [repartition, (article.scoreExplain ?? []).join('\n')].filter(Boolean).join('\n'),
    1024,
  );

  return {
    json: {
      payload: {
        embeds: [
          {
            title: tronquer(article.title, 256),
            url: article.url,
            description: tronquer(article.excerpt, 300) || undefined,
            color: couleur,
            fields: [
              { name: '📅 Publication', value: dateFr(article.date), inline: true },
              { name: '✍️ Auteur', value: tronquer(article.author || article.source || '—', 100), inline: true },
              { name: '📰 Source', value: tronquer(article.source || '—', 100), inline: true },
              { name: `🎯 Score ${article.score} — ${niveau}`, value: detail || '—' },
            ],
            footer: {
              text: tronquer(
                `${(article.themes ?? []).join(' · ')}`
                + `${article.weakSignal ? ' · 🌱 signal faible' : ''}`
                + ' · barème : cœur 3 · périphérie 2 · signal 1 · ×2 si dans le titre',
                2048,
              ),
            },
            timestamp: article.date,
          },
        ],
      },
    },
  };
});
