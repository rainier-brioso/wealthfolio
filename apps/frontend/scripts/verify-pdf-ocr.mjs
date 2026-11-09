import { statSync, readdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const dist = resolve(dirname(fileURLToPath(import.meta.url)), "../../../dist");
for (const name of [
  "worker.min.js",
  "eng.traineddata.gz",
  "tesseract-core-lstm.wasm.js",
  "tesseract-core-lstm.wasm",
  "tesseract-core-simd-lstm.wasm.js",
  "tesseract-core-simd-lstm.wasm",
]) {
  if (statSync(join(dist, "pdf-ocr", name)).size === 0)
    throw new Error(`Missing bundled OCR resource: ${name}`);
}
if (!readdirSync(join(dist, "assets")).some((name) => /^pdf\.worker.*\.mjs$/.test(name)))
  throw new Error("Missing bundled PDF worker");
