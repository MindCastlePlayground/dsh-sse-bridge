// Marker module for the demo bundle.
//
// The bundle's whole content is `cordis.patch.yml`: it inserts a configured
// `sse-bridge` row.  This file exists because a DSH bundle package is expected
// to be importable; it deliberately exports nothing that the Host needs.

export const name = 'sse-bridge-demo'
export const inject = []
export function apply() {}
