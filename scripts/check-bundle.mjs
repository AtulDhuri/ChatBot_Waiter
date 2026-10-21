// Drift guard: fail if the committed static/widget.js is out of sync with the
// source in src/widget/. We rebuild the production bundle in-memory using the
// SAME esbuild options as `npm run build`, then compare byte-for-byte against
// the committed bundle. esbuild output is deterministic for identical input, so
// any difference means someone edited src/widget/ without rebuilding (or hand-
// edited the generated bundle).
//
// Exit 0 = in sync. Exit 1 = stale (with instructions). Exit 2 = build error.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join as pathJoin } from "node:path";
import * as esbuild from "esbuild";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = pathJoin(__dirname, "..");
const committed = pathJoin(repoRoot, "static", "widget.js");

async function main() {
  // Mirror the `build` script options exactly (minify + es5 IIFE). We write to
  // memory via `write: false` so the check never touches the committed files.
  let result;
  try {
    result = await esbuild.build({
      entryPoints: [pathJoin(repoRoot, "src", "widget", "index.js")],
      bundle: true,
      format: "iife",
      target: "es5",
      minify: true,
      sourcemap: true,
      write: false,
      outfile: pathJoin(repoRoot, "static", "widget.js"),
    });
  } catch (err) {
    console.error("✗ bundle drift check failed to build the source:");
    console.error(err && err.message ? err.message : err);
    process.exit(2);
  }

  // Grab the generated JS (ignore the .map; the JS bytes are the drift signal).
  const jsFile = result.outputFiles.find(function (f) {
    return f.path.endsWith("widget.js");
  });
  if (!jsFile) {
    console.error("✗ drift check: esbuild produced no widget.js output.");
    process.exit(2);
  }
  const freshSrc = jsFile.text;

  let committedSrc;
  try {
    committedSrc = readFileSync(committed, "utf8");
  } catch {
    console.error(
      "✗ static/widget.js is missing. Run `npm run build` and commit it."
    );
    process.exit(1);
  }

  if (committedSrc !== freshSrc) {
    console.error(
      "✗ static/widget.js is OUT OF SYNC with src/widget/.\n" +
        "  The committed bundle does not match a fresh build of the source.\n" +
        "  Fix: run `npm run build`, then commit static/widget.js and" +
        " static/widget.js.map."
    );
    process.exit(1);
  }

  console.log("✓ static/widget.js is in sync with src/widget/.");
  process.exit(0);
}

main();
