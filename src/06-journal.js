/**
 * JOURNAL DE COLLECTE
 *
 * Reprend le bilan par flux produit lors de la collecte et l'aplatit pour
 * la table `feed_runs`. Sans cette trace, un flux mort depuis trois semaines
 * passe inaperçu : la vue v_sante_flux s'appuie dessus.
 *
 * Ce nœud lit la sortie du nœud « Collecte des flux » via la clé technique
 * `_feedReport`, portée par le premier item.
 */

const items = $('Collecte des flux').all();
const report = items[0]?.json?._feedReport ?? [];

if (!report.length) {
  // Aucun rapport : rien à journaliser, on ne fait pas échouer l'exécution.
  return [];
}

return report.map((entry) => ({
  json: {
    feed:        String(entry.feed ?? '').slice(0, 255),
    status:      entry.status === 'ok' ? 'ok' : 'échec',
    detail:      String(entry.detail ?? '').slice(0, 500),
    items_found: Number(entry.found) || 0,
    items_kept:  Number(entry.kept) || 0,
  },
}));
