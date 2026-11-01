// Turns photos and PDFs into what the app stores, and reads their text. All of it runs on the phone.

import { WORK_SIDE, findCorners, outputSize, warp } from './scanner.js';

const vendor = (path) => new URL(`vendor/${path}`, document.baseURI).href;
const MAX_IMAGE_SIDE = 2000;
const ORIGINAL_SIDE = 3000;

function canvasToJpeg(canvas, quality = 0.75) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(async (blob) => {
      if (blob) resolve(await blob.arrayBuffer());
      else reject(new Error('Kunde inte spara bilden'));
    }, 'image/jpeg', quality);
  });
}

async function fileToCanvas(file, maxSide = MAX_IMAGE_SIDE) {
  const url = URL.createObjectURL(file);
  try {
    // Not image.decode(): it can hang while the page is in the background, as when returning from the camera.
    const image = await new Promise((resolve, reject) => {
      const loading = new Image();
      loading.onload = () => resolve(loading);
      loading.onerror = () => reject(new Error('Kunde inte läsa bilden'));
      loading.src = url;
    });
    const scale = Math.min(1, maxSide / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(image.naturalWidth * scale);
    canvas.height = Math.round(image.naturalHeight * scale);
    canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function scaledCopy(source, maxSide) {
  const scale = Math.min(1, maxSide / Math.max(source.width, source.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(source.width * scale);
  canvas.height = Math.round(source.height * scale);
  canvas.getContext('2d').drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas;
}

function detectCorners(canvas) {
  const small = scaledCopy(canvas, WORK_SIDE);
  return findCorners(small.getContext('2d').getImageData(0, 0, small.width, small.height));
}

/** The straightened page as a JPEG, or the whole picture if there are no corners. */
export async function pageFromCanvas(canvas, corners) {
  if (!corners) return canvasToJpeg(scaledCopy(canvas, MAX_IMAGE_SIDE));
  const inPixels = corners.map((c) => ({ x: c.x * canvas.width, y: c.y * canvas.height }));
  const { width, height } = outputSize(inPixels, MAX_IMAGE_SIDE);
  const source = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
  const output = document.createElement('canvas');
  output.width = width;
  output.height = height;
  output.getContext('2d').putImageData(new ImageData(warp(source, inPixels, width, height), width, height), 0, 0);
  return canvasToJpeg(output);
}

/**
 * A photo as what the app stores: the straightened page that goes into the PDF, and
 * the larger original with the corners, so that the crop can be adjusted later.
 * corners is null when no receipt was found, and page is then the whole picture.
 */
export async function scanImageFile(file) {
  const canvas = await fileToCanvas(file, ORIGINAL_SIDE);
  const corners = detectCorners(canvas);
  return { page: await pageFromCanvas(canvas, corners), original: await canvasToJpeg(canvas, 0.8), corners };
}

export const jpegToCanvas = (jpeg) => fileToCanvas(new Blob([jpeg], { type: 'image/jpeg' }), ORIGINAL_SIDE);
export const originalToJpeg = (canvas) => canvasToJpeg(canvas, 0.8);

/** A copy turned a quarter clockwise. */
export function turnedCanvas(source) {
  const canvas = document.createElement('canvas');
  canvas.width = source.height;
  canvas.height = source.width;
  const context = canvas.getContext('2d');
  context.translate(canvas.width, 0);
  context.rotate(Math.PI / 2);
  context.drawImage(source, 0, 0);
  return canvas;
}

function jpegSize(bytes) {
  // Walks the JPEG segments to the start-of-frame marker, which holds the size.
  let offset = 2;
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) { offset += 1; continue; }
    const marker = bytes[offset + 1];
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return {
        height: (bytes[offset + 5] << 8) | bytes[offset + 6],
        width: (bytes[offset + 7] << 8) | bytes[offset + 8],
      };
    }
    offset += 2 + ((bytes[offset + 2] << 8) | bytes[offset + 3]);
  }
  throw new Error('Ogiltig JPEG');
}

/** A PDF with one page per JPEG. A JPEG can be embedded as it is, so no library is needed. */
export function jpegsToPdf(jpegs) {
  const encoder = new TextEncoder();
  const chunks = [];
  const offsets = [];
  let length = 0;
  const write = (part) => {
    const bytes = typeof part === 'string' ? encoder.encode(part) : part;
    chunks.push(bytes);
    length += bytes.length;
  };
  const object = (number, body) => {
    offsets[number] = length;
    write(`${number} 0 obj\n${body}\nendobj\n`);
  };

  write('%PDF-1.4\n');
  const pageRefs = jpegs.map((_, index) => `${3 + index * 3} 0 R`).join(' ');
  object(1, '<< /Type /Catalog /Pages 2 0 R >>');
  object(2, `<< /Type /Pages /Kids [${pageRefs}] /Count ${jpegs.length} >>`);

  jpegs.forEach((jpeg, index) => {
    const bytes = new Uint8Array(jpeg);
    const { width, height } = jpegSize(bytes);
    // 150 dpi makes the page roughly paper sized.
    const pageWidth = (width * 72 / 150).toFixed(2);
    const pageHeight = (height * 72 / 150).toFixed(2);
    const [page, content, image] = [3 + index * 3, 4 + index * 3, 5 + index * 3];
    object(page, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] `
      + `/Resources << /XObject << /Im0 ${image} 0 R >> >> /Contents ${content} 0 R >>`);
    const drawing = `q ${pageWidth} 0 0 ${pageHeight} 0 0 cm /Im0 Do Q`;
    object(content, `<< /Length ${drawing.length} >>\nstream\n${drawing}\nendstream`);
    offsets[image] = length;
    write(`${image} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} `
      + `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${bytes.length} >>\nstream\n`);
    write(bytes);
    write('\nendstream\nendobj\n');
  });

  const count = 3 + jpegs.length * 3;
  const xrefStart = length;
  write(`xref\n0 ${count}\n0000000000 65535 f \n`);
  for (let number = 1; number < count; number += 1) {
    write(`${String(offsets[number]).padStart(10, '0')} 00000 n \n`);
  }
  write(`trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`);

  const pdf = new Uint8Array(length);
  let position = 0;
  for (const chunk of chunks) {
    pdf.set(chunk, position);
    position += chunk.length;
  }
  return pdf.buffer;
}

// MARK: OCR

let workerPromise;

function ocrWorker() {
  workerPromise ??= (async () => {
    const worker = await window.Tesseract.createWorker(['swe', 'eng'], 1, {
      workerPath: vendor('worker.min.js'),
      corePath: vendor(''),
      langPath: vendor('lang'),
      gzip: true,
      cacheMethod: 'none',
      workerBlobURL: false,
    });
    // Mode 4 reads a single column of rows, which is what a receipt is.
    await worker.setParameters({ tessedit_pageseg_mode: '4', preserve_interword_spaces: '1' });
    return worker;
  })();
  return workerPromise;
}

/** Greyscale with stretched contrast, since faded thermal paper is hard to read otherwise. */
function prepareForOcr(source) {
  const scale = Math.min(2, 2400 / Math.max(source.width, source.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(source.width * scale);
  canvas.height = Math.round(source.height * scale);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  const image = context.getImageData(0, 0, canvas.width, canvas.height);
  const pixels = image.data;
  const histogram = new Uint32Array(256);
  const gray = new Uint8Array(pixels.length / 4);
  for (let i = 0; i < gray.length; i += 1) {
    gray[i] = (pixels[i * 4] * 299 + pixels[i * 4 + 1] * 587 + pixels[i * 4 + 2] * 114) / 1000;
    histogram[gray[i]] += 1;
  }
  const cut = gray.length * 0.01;
  let low = 0;
  let high = 255;
  for (let seen = 0; low < 255 && (seen += histogram[low]) < cut;) low += 1;
  for (let seen = 0; high > 0 && (seen += histogram[high]) < cut;) high -= 1;
  const range = Math.max(1, high - low);
  for (let i = 0; i < gray.length; i += 1) {
    const value = Math.max(0, Math.min(255, ((gray[i] - low) * 255) / range));
    pixels[i * 4] = pixels[i * 4 + 1] = pixels[i * 4 + 2] = value;
  }
  context.putImageData(image, 0, 0);
  return canvas;
}

async function recognize(canvas) {
  const worker = await ocrWorker();
  const { data } = await worker.recognize(prepareForOcr(canvas));
  return data.text.split('\n');
}

export async function linesFromJpeg(jpeg) {
  const canvas = await fileToCanvas(new Blob([jpeg], { type: 'image/jpeg' }));
  return recognize(canvas);
}

// MARK: PDF import

function pdfjs() {
  const lib = window.pdfjsLib;
  lib.GlobalWorkerOptions.workerSrc = vendor('pdf.worker.min.js');
  return lib;
}

async function renderPage(page, maxSide) {
  const base = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: maxSide / Math.max(base.width, base.height) });
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(viewport.width);
  canvas.height = Math.round(viewport.height);
  await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
  return canvas;
}

async function textRows(page) {
  const content = await page.getTextContent();
  const rows = new Map();
  for (const item of content.items) {
    if (!item.str?.trim()) continue;
    const y = Math.round(item.transform[5] / 3) * 3;
    if (!rows.has(y)) rows.set(y, []);
    rows.get(y).push(item);
  }
  return [...rows.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([, items]) => items.sort((a, b) => a.transform[4] - b.transform[4]).map((i) => i.str).join('  '));
}

/** A preview image of the first page. */
export async function pdfPreview(pdfBytes) {
  const doc = await pdfjs().getDocument({ data: pdfBytes.slice(0) }).promise;
  try {
    return await canvasToJpeg(await renderPage(await doc.getPage(1), 1400));
  } finally {
    doc.destroy();
  }
}

export async function linesFromPdf(pdfBytes) {
  const doc = await pdfjs().getDocument({ data: pdfBytes.slice(0) }).promise;
  try {
    const pages = [];
    for (let number = 1; number <= doc.numPages; number += 1) pages.push(await doc.getPage(number));

    // Digital invoices already have a text layer, which beats OCR.
    const digital = (await Promise.all(pages.map(textRows))).flat();
    if ((digital.join('').match(/\p{L}/gu) ?? []).length >= 30) return digital;

    let lines = [];
    for (const page of pages) lines = lines.concat(await recognize(await renderPage(page, 2400)));
    return lines;
  } finally {
    doc.destroy();
  }
}
