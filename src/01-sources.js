/**
 * SOURCES — catalogue des flux surveillés.
 *
 * Le tableau ci-dessous est GÉNÉRÉ depuis config/sources.yaml au moment du
 * build : ne pas l'éditer ici, la modification serait écrasée.
 * Pour ajouter ou retirer un flux, éditer config/sources.yaml puis lancer
 *   docker compose run --rm builder
 *
 * Chaque source produit un item ; le nœud suivant les télécharge en parallèle.
 */

const SOURCES = /* @@SOURCES@@ */ [];

return SOURCES.map((json) => ({ json }));
