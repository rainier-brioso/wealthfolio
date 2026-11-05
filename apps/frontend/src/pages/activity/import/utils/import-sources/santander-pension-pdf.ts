import type { Worker as OcrWorker } from "tesseract.js";

export interface PensionPdfRow {
  operationDate: string;
  valueDate: string;
  concept: string;
  amount: string;
  units: string;
  price: string;
}
export interface PensionPdfPage {
  header: string;
  summary: string;
  rows: PensionPdfRow[];
}

// The Santander statement has a ruled, six-column movement table. Reading each
// column separately avoids OCR joining adjacent numbers across the grid.
export async function readSantanderPensionPdf(
  file: File,
  progress: (value: number) => void,
): Promise<PensionPdfPage> {
  if (file.size > 20 * 1024 * 1024) throw new Error("pdf-limit");
  const pdfjs = await import("pdfjs-dist");
  const workerUrl = (await import("pdfjs-dist/build/pdf.worker.min.mjs?url")).default;
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  const task = pdfjs.getDocument({
    data: new Uint8Array(await file.arrayBuffer()),
    isEvalSupported: false,
  });
  let ocr: OcrWorker | undefined;
  try {
    const pdf = await task.promise;
    if (pdf.numPages !== 1) throw new Error("pdf-pages");
    const page = await pdf.getPage(1);
    const viewport = page.getViewport({ scale: 220 / 72 });
    if (viewport.width * viewport.height > 12_000_000) throw new Error("pdf-limit");
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    await page.render({ canvas, viewport }).promise;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("pdf-canvas");
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    const dark = (x: number, y: number) => data[(y * canvas.width + x) * 4] < 100;
    const groups = (values: number[]) =>
      values.filter((value, index) => index === 0 || value - values[index - 1] > 4);
    const horizontal: number[] = [];
    for (let y = Math.floor(canvas.height * 0.18); y < canvas.height * 0.6; y++) {
      let count = 0;
      for (let x = 0; x < canvas.width; x++) if (dark(x, y)) count++;
      if (count > canvas.width * 0.8) horizontal.push(y);
    }
    const lines = groups(horizontal);
    if (lines.length < 4) throw new Error("pdf-layout");
    const top = lines[2] + 5;
    const bottom = lines[3] - 3;
    const vertical: number[] = [];
    for (let x = 0; x < canvas.width; x++) {
      let count = 0;
      for (let y = top; y < bottom; y++) if (dark(x, y)) count++;
      if (count > (bottom - top) * 0.9) vertical.push(x);
    }
    const columns = groups(vertical);
    if (columns.length !== 7) throw new Error("pdf-layout");
    const { createWorker, PSM } = await import("tesseract.js");
    const assets = new URL(`${import.meta.env.BASE_URL}pdf-ocr`, location.href).href;
    ocr = await createWorker("eng", 1, {
      workerPath: `${assets}/worker.min.js`,
      corePath: assets,
      langPath: assets,
      workerBlobURL: false,
      cacheMethod: "none",
    });
    await ocr.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_BLOCK });
    const recognize = async (
      left: number,
      upper: number,
      width: number,
      height: number,
      singleLine = false,
    ) => {
      await ocr!.setParameters({
        tessedit_char_whitelist: "",
        tessedit_pageseg_mode: singleLine ? PSM.SINGLE_LINE : PSM.SINGLE_BLOCK,
      });
      const crop = document.createElement("canvas");
      const padding = singleLine ? 24 : 0;
      crop.width = width + padding * 2;
      crop.height = height + padding * 2;
      const cropContext = crop.getContext("2d")!;
      cropContext.fillStyle = "white";
      cropContext.fillRect(0, 0, crop.width, crop.height);
      cropContext.drawImage(canvas, left, upper, width, height, padding, padding, width, height);
      return (await ocr!.recognize(crop, {}, { text: true, blocks: true })).data;
    };
    const header = await recognize(0, 0, canvas.width, lines[2] - 4);
    progress(20);
    const cells: { text: string; y: number }[][] = [];
    for (let column = 0; column < 6; column++) {
      const result = await recognize(
        columns[column] + 5,
        top,
        columns[column + 1] - columns[column] - 6,
        bottom - top,
        false,
      );
      cells.push(
        (result.blocks ?? []).flatMap((block) =>
          block.paragraphs.flatMap((paragraph) =>
            paragraph.lines.map((line) => ({
              text: line.text.trim(),
              y: (line.bbox.y0 + line.bbox.y1) / 2,
            })),
          ),
        ),
      );
      progress(20 + column * 10);
    }
    const rowCenters = cells[3];
    const rows: PensionPdfRow[] = [];
    const spacing = Math.min(
      ...rowCenters.slice(1).map((cell, index) => cell.y - rowCenters[index].y),
    );
    if (!Number.isFinite(spacing) || spacing < 15) throw new Error("pdf-layout");
    for (const cell of rowCenters) {
      const values = cells.map(
        (column) => column.find((item) => Math.abs(item.y - cell.y) < 12)?.text ?? "",
      );
      for (const column of [0, 1, 3, 4, 5]) {
        if (column < 2 && !values[column]) continue;
        const result = await recognize(
          columns[column] + 5,
          Math.round(top + cell.y - spacing / 2 + 2),
          columns[column + 1] - columns[column] - 6,
          Math.floor(spacing - 4),
          true,
        );
        values[column] = result.text.trim();
      }
      rows.push({
        operationDate: values[0],
        valueDate: values[1],
        concept: values[2],
        amount: values[3],
        units: values[4],
        price: values[5],
      });
    }
    const summary = await recognize(
      0,
      lines[3] + 5,
      Math.floor(canvas.width * 0.446),
      Math.floor(canvas.height * 0.245),
    );
    const heading = await recognize(
      0,
      lines[3] + 5,
      canvas.width,
      Math.floor(canvas.height * 0.028),
    );
    const controlLines = (summary.blocks ?? []).flatMap((block) =>
      block.paragraphs.flatMap((paragraph) => paragraph.lines),
    );
    const controls: string[] = [];
    for (const line of controlLines) {
      if (
        !/consolidado|operaciones de|Revalorizaci|Cuenta Totales|Unidad de Cuenta al/i.test(
          line.text,
        )
      )
        continue;
      const value = await recognize(
        Math.floor(canvas.width * 0.32),
        lines[3] + 5 + line.bbox.y0 - 5,
        Math.floor(canvas.width * 0.126) - 1,
        line.bbox.y1 - line.bbox.y0 + 10,
        true,
      );
      controls.push(line.text.replace(/[-\d.,\s]+$/, "") + " " + value.text.trim());
    }
    progress(100);
    return { header: header.text, summary: heading.text + "\n" + controls.join("\n"), rows };
  } finally {
    await ocr?.terminate();
    await task.destroy();
  }
}
