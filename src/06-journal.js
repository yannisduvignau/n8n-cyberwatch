/**
 * COLLECTION LOG
 *
 * Takes the per-feed report produced during collection and flattens it for
 * the `feed_runs` table. Without this trace, a feed that has been dead for
 * three weeks goes unnoticed: the v_sante_flux view relies on it.
 *
 * This node reads the output of the "Collecte des flux" node via the
 * technical key `_feedReport`, carried by the first item.
 */

const items = $('Collecte des flux').all();
const report = items[0]?.json?._feedReport ?? [];

if (!report.length) {
  // No report: nothing to log, don't fail the execution.
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
