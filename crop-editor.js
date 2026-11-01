// The view where the corners of a receipt can be moved by hand.
import { isUsableQuad, orderCorners } from './scanner.js';
import { jpegToCanvas, originalToJpeg, pageFromCanvas, turnedCanvas } from './documents.js';

const dialog = document.getElementById('crop-dialog');
const area = dialog.querySelector('.k-crop-area');
const stage = dialog.querySelector('.k-crop-stage');
const outlines = [...dialog.querySelectorAll('polygon')];
const handles = [...dialog.querySelectorAll('.k-crop-handle')];
const message = dialog.querySelector('.k-crop-message');

const WHOLE = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
const SUGGESTED = [{ x: 0.1, y: 0.1 }, { x: 0.9, y: 0.1 }, { x: 0.9, y: 0.9 }, { x: 0.1, y: 0.9 }];

let canvas;
let corners;
let turned = false;
let finish;

function draw() {
  handles.forEach((handle, index) => {
    handle.style.left = `${corners[index].x * 100}%`;
    handle.style.top = `${corners[index].y * 100}%`;
  });
  const points = corners.map((c) => `${c.x},${c.y}`).join(' ');
  outlines.forEach((outline) => outline.setAttribute('points', points));
}

function fit() {
  if (!canvas) return;
  const style = getComputedStyle(area);
  const width = area.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
  const height = area.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
  const scale = Math.min(width / canvas.width, height / canvas.height);
  stage.style.width = `${Math.floor(canvas.width * scale)}px`;
  stage.style.height = `${Math.floor(canvas.height * scale)}px`;
}

function showCanvas(next) {
  canvas = next;
  stage.querySelector('canvas')?.remove();
  stage.prepend(canvas);
  fit();
  draw();
}

handles.forEach((handle, index) => {
  handle.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    handle.setPointerCapture(event.pointerId);
    message.hidden = true;
  });
  handle.addEventListener('pointermove', (event) => {
    if (!handle.hasPointerCapture(event.pointerId)) return;
    const box = stage.getBoundingClientRect();
    corners[index] = {
      x: Math.max(0, Math.min(1, (event.clientX - box.left) / box.width)),
      y: Math.max(0, Math.min(1, (event.clientY - box.top) / box.height)),
    };
    draw();
  });
});

dialog.querySelector('[data-crop="turn"]').addEventListener('click', () => {
  turned = true;
  corners = corners.map(({ x, y }) => ({ x: 1 - y, y: x }));
  showCanvas(turnedCanvas(canvas));
});

dialog.querySelector('[data-crop="whole"]').addEventListener('click', () => {
  corners = WHOLE.map((c) => ({ ...c }));
  draw();
});

/** Hands over the result and lets go of the large picture. */
function end(result) {
  stage.querySelector('canvas')?.remove();
  canvas = null;
  const done = finish;
  finish = null;
  done?.(result);
  if (dialog.open) dialog.close();
}

dialog.querySelector('[data-crop="cancel"]').addEventListener('click', () => end(null));

dialog.querySelector('[data-crop="save"]').addEventListener('click', async (event) => {
  const ordered = orderCorners(corners);
  if (!isUsableQuad(ordered)) {
    message.hidden = false;
    return;
  }
  event.currentTarget.disabled = true;
  try {
    const result = { corners: ordered, page: await pageFromCanvas(canvas, ordered) };
    if (turned) result.original = await originalToJpeg(canvas);
    end(result);
  } catch (error) {
    console.error(error);
    message.hidden = false;
  } finally {
    dialog.querySelector('[data-crop="save"]').disabled = false;
  }
});

// Closing by other means than the buttons, such as the Esc key.
dialog.addEventListener('close', () => {
  if (finish) end(null);
});

window.addEventListener('resize', fit);

/** Opens the view. Resolves to { corners, page, original? }, or null if the user cancels. */
export async function adjustCrop(original, startCorners) {
  const loaded = await jpegToCanvas(original);
  corners = (startCorners ?? SUGGESTED).map((c) => ({ ...c }));
  turned = false;
  message.hidden = true;
  dialog.showModal();
  showCanvas(loaded);
  return new Promise((resolve) => { finish = resolve; });
}
