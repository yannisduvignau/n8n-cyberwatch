/**
 * SOURCES — catalogue of monitored feeds.
 *
 * The array below is GENERATED from config/sources.yaml at build time:
 * do not edit it here, the change would be overwritten.
 * To add or remove a feed, edit config/sources.yaml then run
 *   docker compose run --rm builder
 *
 * Each source produces one item; the next node downloads them in parallel.
 */

const SOURCES = /* @@SOURCES@@ */ [];

return SOURCES.map((json) => ({ json }));
