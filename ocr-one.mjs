import { createWorker } from 'tesseract.js';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const worker = await createWorker('spa', 1, { langPath: dirname(fileURLToPath(import.meta.url)), gzip: false, cacheMethod: 'none' });
await worker.setParameters({ tessedit_pageseg_mode: process.argv[3] ?? '6', preserve_interword_spaces: '1', user_defined_dpi: '300', tessedit_char_whitelist: '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZÁÉÍÓÚÑabcdefghijklmnopqrstuvwxyzáéíóúñ,.% ' });
const result = await worker.recognize(process.argv[2]);
console.log('CONFIDENCE', result.data.confidence);
console.log(result.data.text);
await worker.terminate();
