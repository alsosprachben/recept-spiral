/**
 * Production build: bundle the SPA into out/, copy the verbatim assets (the WebAssembly
 * banks, the worker and the audio worklet), then check the result against the DataVec
 * deploy caps so a violation fails here rather than at publish time.
 *
 *   bun run build        (the DataVec builder runs `bun --bun run build`)
 */
import { $ } from "bun";
import { cp, mkdir, readdir, rm, stat } from "node:fs/promises";
import { join, relative } from "node:path";

// Caps enforced by POST /api/deploy/<slug>; see mnvkd static-site-bake.md.
const MAX_FILES = 5000;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_BYTES = 50 * 1024 * 1024;
const MAX_PATH = 255;

const OUT = "out";

async function walk(dir: string, base = dir): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`symlink in ${OUT}/ (the deploy API rejects these): ${relative(base, full)}`);
    } else if (entry.isDirectory()) {
      out.push(...(await walk(full, base)));
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

async function main() {
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });

  // The HTML entry point pulls in index.tsx and styles.css; Bun bundles and hashes them.
  // NODE_ENV must be defined explicitly or React's development build — larger, and far
  // slower for the 60 Hz control updates — is what ships.
  await $`bun build src/index.html --outdir ${OUT} --minify --define ${'process.env.NODE_ENV="production"'}`;

  // Verbatim assets: the worker and worklet are loaded by URL, not imported, and the .wasm
  // files are fetched at runtime — none of them are part of the module graph.
  await cp("public", OUT, { recursive: true });

  const index = Bun.file(join(OUT, "index.html"));
  if (!(await index.exists())) throw new Error(`${OUT}/index.html missing after build`);

  const files = await walk(OUT);
  let total = 0;
  for (const f of files) {
    const rel = relative(OUT, f);
    const { size } = await stat(f);
    total += size;
    if (size > MAX_FILE_BYTES) {
      throw new Error(`${rel} is ${(size / 1048576).toFixed(1)} MiB, over the 10 MiB per-file cap`);
    }
    if (rel.length > MAX_PATH) throw new Error(`path longer than ${MAX_PATH}: ${rel}`);
  }
  if (files.length > MAX_FILES) {
    throw new Error(`${files.length} files, over the ${MAX_FILES} cap`);
  }
  if (total > MAX_TOTAL_BYTES) {
    throw new Error(`${(total / 1048576).toFixed(1)} MiB total, over the 50 MiB cap`);
  }

  // Required at runtime; a rename in public/ would otherwise fail only in the browser.
  for (const required of ["bank.wasm", "bank_f32.wasm", "mic-worker.js", "mic-worklet.js"]) {
    if (!(await Bun.file(join(OUT, required)).exists())) {
      throw new Error(`${required} missing from ${OUT}/ (expected in public/)`);
    }
  }

  console.log(
    `built ${OUT}/: ${files.length} files, ${(total / 1024).toFixed(0)} KiB ` +
    `(caps: ${MAX_FILES} files, 10 MiB/file, 50 MiB total)`,
  );
}

await main();
