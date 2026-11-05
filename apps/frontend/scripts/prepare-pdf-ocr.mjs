import { createRequire } from "node:module";
import { mkdirSync, copyFileSync, readdirSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const worker = require.resolve("tesseract.js/dist/worker.min.js");
const core = dirname(
  createRequire(require.resolve("tesseract.js")).resolve("tesseract.js-core/package.json"),
);
const destination = resolve(dirname(fileURLToPath(import.meta.url)), "../public/pdf-ocr");
mkdirSync(destination, { recursive: true });
copyFileSync(worker, join(destination, "worker.min.js"));
for (const name of readdirSync(core).filter((name) => /\.wasm(\.js)?$/.test(name)))
  copyFileSync(join(core, name), join(destination, name));
copyFileSync(
  join(
    dirname(require.resolve("@tesseract.js-data/eng/package.json")),
    "4.0.0_best_int/eng.traineddata.gz",
  ),
  join(destination, "eng.traineddata.gz"),
);
for (const [packageName, label] of [
  ["tesseract.js", "tesseract"],
  ["@tesseract.js-data/eng", "eng"],
  ["pdfjs-dist", "pdfjs"],
]) {
  const root = dirname(require.resolve(`${packageName}/package.json`));
  const license =
    readdirSync(root).find((name) => /^license(?:\.\w+)?$/i.test(name)) ?? "package.json";
  copyFileSync(join(root, license), join(destination, `${label}-LICENSE`));
}
copyFileSync(
  join(core, readdirSync(core).find((name) => /^license(?:\.\w+)?$/i.test(name)) ?? "package.json"),
  join(destination, "core-LICENSE"),
);
