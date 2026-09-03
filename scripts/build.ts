/**
 * Production build: bundle the SPA into dist/, copy the verbatim assets (the WebAssembly
 * banks, the worker and the audio worklet), then check the result against the DataVec
 * deploy caps so a violation fails here rather than at publish time.
 *
 * The output directory is `dist/` because that is what the bake looks for:
 * customer-bake-remote.sh runs `bun install && $SITE_BUILD_CMD` (default `bun run build`)
 * and then requires `$SITE_DIST_DIR/` (default `dist`) to exist.
 */
import { $ } from "bun";
import { cp, mkdir, readdir, rm, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { VERSIONED_ASSETS, versionedAsset } from "../src/lib/assets";

/**
 * Bun content-hashes the bundle it emits, but the files copied verbatim from public/ keep
 * stable names — so a browser that cached mic-worklet.js or bank.wasm would keep the old
 * copy across a deploy and silently miss a fix. Hash their contents and put the result in
 * their filenames (see src/lib/assets.ts for why not a query string).
 */
async function assetVersion(): Promise<string> {
  const names = (await readdir("public")).sort();
  const hasher = new Bun.CryptoHasher("sha256");
  for (const name of names) {
    hasher.update(name);
    hasher.update(new Uint8Array(await Bun.file(join("public", name)).arrayBuffer()));
  }
  return hasher.digest("hex").slice(0, 12);
}

// Caps enforced by POST /api/deploy/<slug>; see mnvkd static-site-bake.md.
const MAX_FILES = 5000;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_BYTES = 50 * 1024 * 1024;
const MAX_PATH = 255;

const OUT = "dist";

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

  const version = await assetVersion();

  // The HTML entry point pulls in index.tsx and styles.css; Bun bundles and hashes them.
  // NODE_ENV must be defined explicitly or React's development build — larger, and far
  // slower for the 60 Hz control updates — is what ships.
  await $`bun build src/index.html --outdir ${OUT} --minify \
    --define ${'process.env.NODE_ENV="production"'} \
    --define ${`__BUILD_ID__="${version}"`}`;

  // Verbatim assets: the worker and worklet are loaded by URL, not imported, and the .wasm
  // files are fetched at runtime — none of them are part of the module graph. The four the
  // app loads at runtime get the version in their filename.
  const versioned = new Set<string>(VERSIONED_ASSETS);
  for (const name of await readdir("public")) {
    const target = versioned.has(name) ? versionedAsset(name, version) : name;
    await cp(join("public", name), join(OUT, target));
  }

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

  // Required at runtime under exactly the names the app will request; a mismatch here would
  // otherwise surface only in the browser, as the server returning index.html instead.
  for (const asset of VERSIONED_ASSETS) {
    const name = versionedAsset(asset, version);
    if (!(await Bun.file(join(OUT, name)).exists())) {
      throw new Error(`${name} missing from ${OUT}/ (expected ${asset} in public/)`);
    }
  }

  console.log(
    `built ${OUT}/: ${files.length} files, ${(total / 1024).toFixed(0)} KiB, ` +
    `asset version ${version} (caps: ${MAX_FILES} files, 10 MiB/file, 50 MiB total)`,
  );
}

await main();
