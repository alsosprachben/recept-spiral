/**
 * Development server: rebuild on change, serve out/ over http://localhost:3000.
 *
 * getUserMedia needs a secure context, and localhost counts as one — so the microphone
 * works here without TLS.
 */
import { $ } from "bun";
import { cp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

const OUT = "out";
const PORT = Number(process.env.PORT ?? 3000);

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });
await $`bun build src/index.html --outdir ${OUT}`;
await cp("public", OUT, { recursive: true });

// keep the bundle fresh; public/ is copied once above and watched below
const watcher = Bun.spawn(["bun", "build", "src/index.html", "--outdir", OUT, "--watch"], {
  stdout: "inherit",
  stderr: "inherit",
});

const publicWatch = new AbortController();
(async () => {
  const { watch } = await import("node:fs");
  watch("public", { signal: publicWatch.signal }, () => {
    void cp("public", OUT, { recursive: true }).catch(() => {});
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
    // single-page app: unknown paths fall back to the shell
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
