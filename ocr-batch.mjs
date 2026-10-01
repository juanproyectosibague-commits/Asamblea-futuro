import { createWorker } from 'tesseract.js';
import { readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const imageDirectory = process.argv[2];
const outputDirectory = process.argv[3];
if (!imageDirectory || !outputDirectory) {
  throw new Error('Usage: node ocr-batch.mjs <image-directory> <output-directory>');
}

const images = (await readdir(imageDirectory))
  .filter((name) => /^general-\d+\.png$/i.test(name))
  .sort();
const worker = await createWorker('spa', 1, {
  langPath: dirname(fileURLToPath(import.meta.url)),
  gzip: false,
  cacheMethod: 'none',
});
await worker.setParameters({
  tessedit_pageseg_mode: '6',
  preserve_interword_spaces: '1',
  user_defined_dpi: '300',
});

try {
  for (const image of images) {
    const result = await worker.recognize(join(imageDirectory, image));
    const page = image.match(/\d+/)?.[0] ?? image;
    const text = `CONFIDENCE ${result.data.confidence}\n${result.data.text}`;
    await writeFile(join(outputDirectory, `page-${page}.txt`), text, 'utf8');
    console.log(`${image}: ${result.data.confidence}`);
  }
} finally {
  await worker.terminate();
}
