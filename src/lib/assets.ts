/**
 * Naming for the assets the bundler copies verbatim rather than content-hashing: the audio
 * worklet, the worker and the WebAssembly banks.
 *
 * The version goes in the FILENAME, not in a query string. The platform's static handler
 * matches the request path against a file without stripping the query, so `foo.js?v=abc`
 * matches nothing and falls through to the SPA shell — the browser then refuses to execute
 * `index.html` as JavaScript ("expected expression, got '<'"). A versioned filename is a
 * real path and works on any static server.
 *
 * Shared by the app and by scripts/build.ts so the name written and the name requested
 * cannot drift.
 */
export const VERSIONED_ASSETS = [
  "mic-worklet.js",
  "mic-worker.js",
  "bank.wasm",
  "bank_f32.wasm",
] as const;

export function versionedAsset(name: string, version: string): string {
  const dot = name.lastIndexOf(".");
  if (dot < 0) return `${name}.${version}`;
  return `${name.slice(0, dot)}.${version}${name.slice(dot)}`;
}
