/**
 * DISCORD MESSAGE
 *
 * Builds the embed sent to the team channel for high-scoring articles.
 * The next node simply POSTs `payload` to the webhook.
 *
 * Discord limits enforced here: title 256 chars, description 4096,
 * field value 1024, footer 2048.
 */

const COULEURS = {
  signalFaible: 0x2ecc71, // green: to keep an eye on
  tresEleve:    0xe74c3c, // red: read first
  eleve:        0x3498db, // blue: normal reading
};

const SEUIL_TRES_ELEVE = /* @@SEUIL_URGENT@@ */ 15;
const SEUIL_ALERTE = /* @@SEUIL_ALERTE@@ */ 8;

/**
 * Escapes Discord markdown. Feed titles/excerpts are untrusted: without this a
 * crafted item could inject a masked link — [ANSSI officiel](https://evil) —
 * or styling into the team channel. Discord consumes the backslash, so escaped
 * text still renders as the plain original.
 */
const escapeMd = (s) => String(s ?? '').replace(/[\\`*_~|[\]()]/g, '\\$&');

/** Truncates cleanly, without leaving half a word. */
function tronquer(texte, max) {
  const s = String(texte ?? '');
  if (s.length <= max) return s;
  const coupe = s.slice(0, max - 1);
  const espace = coupe.lastIndexOf(' ');
  return `${espace > max * 0.6 ? coupe.slice(0, espace) : coupe}…`;
}

const formatDate = (iso) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-GB', {
    timeZone: 'Europe/Paris',
    dateStyle: 'medium',
    timeStyle: 'short',
  });
};

return $input.all().map(({ json: article }) => {
  const niveau =
    article.score >= SEUIL_TRES_ELEVE ? 'very high' : article.score >= SEUIL_ALERTE ? 'high' : 'moderate';

  const couleur = article.weakSignal
    ? COULEURS.signalFaible
    : article.score >= SEUIL_TRES_ELEVE
      ? COULEURS.tresEleve
      : COULEURS.eleve;

  // Score breakdown across topics, zero-score topics omitted.
  const repartition = Object.entries(article.scoreDetail ?? {})
    .filter(([, v]) => v > 0)
    .map(([axe, v]) => `**${axe}**: ${v}`)
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
            title: tronquer(escapeMd(article.title), 256),
            url: article.url,
            description: tronquer(escapeMd(article.excerpt), 300) || undefined,
            color: couleur,
            fields: [
              { name: '📅 Published', value: formatDate(article.date), inline: true },
              { name: '✍️ Author', value: tronquer(escapeMd(article.author || article.source || '—'), 100), inline: true },
              { name: '📰 Source', value: tronquer(escapeMd(article.source || '—'), 100), inline: true },
              { name: `🎯 Score ${article.score} — ${niveau}`, value: detail || '—' },
            ],
            footer: {
              text: tronquer(
                `${(article.themes ?? []).join(' · ')}`
                + `${article.weakSignal ? ' · 🌱 weak signal' : ''}`
                + ' · scale: core 3 · periphery 2 · signal 1 · ×2 if in title',
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
