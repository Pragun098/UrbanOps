/**
 * Leaflet with the markercluster plugin attached.
 *
 * leaflet.markercluster is a UMD build that reads a *global* `L`, which bundlers
 * don't provide. This module sets window.L before the plugin is evaluated
 * (ES modules evaluate in import order). Client-only: load via next/dynamic.
 */

import L from "leaflet";

if (typeof window !== "undefined") {
  (window as unknown as { L: typeof L }).L = L;
}

export default L;
