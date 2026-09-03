/**
 * Hash of the contents of public/, injected by scripts/build.ts. The app appends it to the
 * URLs of the assets that are not content-hashed by the bundler — the worker, the audio
 * worklet and the WebAssembly banks — so a deploy is never served a stale cached copy.
 */
declare const __BUILD_ID__: string;
