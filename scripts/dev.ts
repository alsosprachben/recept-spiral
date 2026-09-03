/**
 * Development server: rebuild on change, serve dist/ over http://localhost:3000.
 *
 * getUserMedia needs a secure context, and localhost counts as one — so the microphone
 * works here without TLS.
 *
 * The verbatim assets are copied under the same versioned filenames the production build
 * uses (with the version "dev"), so the paths the app requests are identical in both.
 */
import { $ } from "bun";
import { cp, mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { VERSIONED_ASSETS, versionedAsset } from "../src/lib/assets";

const OUT = "dist";
const PORT = Number(process.env.PORT ?? 3000);
const VERSION = "dev";
const DEFINE = `__BUILD_ID__="${VERSION}"`;

async function copyPublic() {
  const versioned = new Set<string>(VERSIONED_ASSETS);
  for (const name of await readdir("public")) {
    const target = versioned.has(name) ? versionedAsset(name, VERSION) : name;
    await cp(join("public", name), join(OUT, target));
  }
}

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });
await $`bun build src/index.html --outdir ${OUT} --define ${DEFINE}`;
await copyPublic();

// keep the bundle fresh; public/ is copied above and re-copied on change below
const watcher = Bun.spawn(
  ["bun", "build", "src/index.html", "--outdir", OUT, "--define", DEFINE, "--watch"],
  { stdout: "inherit", stderr: "inherit" },
);

const publicWatch = new AbortController();
(async () => {
  const { watch } = await import("node:fs");
  watch("public", { signal: publicWatch.signal }, () => {
    void copyPublic().catch(() => {});
  });
})();

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    let path = decodeURIComponent(url.pathname);
    if (path.endsWith("/")) path += "index.html";
    const file = Bun.file(join(OUT, path));
    if (await file.exists()) {
      return new Response(file, { headers: { "cache-control": "no-store" } });
    }
    // Mirror the platform: unknown paths fall back to the shell. That is what turns a
    // missing asset into "expected expression, got '<'", so surface it here too.
    if (/\.(js|wasm|css|map)$/.test(path)) {
      console.warn(`404 ${path} — falling back to index.html, as the platform would`);
    }
    const index = Bun.file(join(OUT, "index.html"));
    if (await index.exists()) {
      return new Response(index, { headers: { "cache-control": "no-store" } });
    }
    return new Response("not found", { status: 404 });
  },
});

console.log(`dev server: http://localhost:${server.port}`);

process.on("SIGINT", () => {
  publicWatch.abort();
  watcher.kill();
  void server.stop(true);
  process.exit(0);
});
