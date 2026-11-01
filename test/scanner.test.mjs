// Run with: node test/scanner.test.mjs
// Draws made-up photos of a receipt and checks that the corners are found and the paper comes out straight.
import assert from 'node:assert/strict';
import { findCorners, isUsableQuad, orderCorners, outputSize, warp } from '../scanner.js';

function seeded(seed) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

function inside(quad, x, y) {
  let sign = 0;
  for (let i = 0; i < 4; i += 1) {
    const a = quad[i];
    const b = quad[(i + 1) % 4];
    const turn = (b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x);
    if (turn === 0) continue;
    if (sign && Math.sign(turn) !== sign) return false;
    sign = Math.sign(turn);
  }
  return true;
}

/** background(x, y, random) gives the table's brightness. Paper gets rows of dark text. */
function photo({ width, height, quad, background, paper = 235, shadow = 0, seed = 1 }) {
  const random = seeded(seed);
  const data = new Uint8ClampedArray(width * height * 4);
  const px = quad.map((p) => ({ x: p.x * width, y: p.y * height }));
  const top = Math.min(...px.map((p) => p.y));
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let value = background(x, y, random);
      if (inside(px, x + 0.5, y + 0.5)) {
        value = paper + (random() - 0.5) * 8 - shadow * (x / width);
        const row = Math.floor((y - top) / 9);
        if (row % 2 === 0 && (y - top) % 9 < 4 && (x * 7 + row * 13) % 17 < 9) value = 50;
      }
      const i = (y * width + x) * 4;
      data[i] = value;
      data[i + 1] = value;
      data[i + 2] = value;
      data[i + 3] = 255;
    }
  }
  return { data, width, height };
}

const dark = (x, y, random) => 40 + random() * 12;
const wood = (x, y, random) => 95 + Math.sin(y / 5) * 16 + random() * 14;
const lightTable = (x, y, random) => 188 + random() * 6;
const shaded = (x, y, random) => 30 + (x / 400) * 70 + random() * 6;

const upright = [{ x: 0.3, y: 0.12 }, { x: 0.7, y: 0.12 }, { x: 0.7, y: 0.88 }, { x: 0.3, y: 0.88 }];
const tilted = [{ x: 0.42, y: 0.08 }, { x: 0.74, y: 0.17 }, { x: 0.56, y: 0.92 }, { x: 0.24, y: 0.83 }];
const perspective = [{ x: 0.36, y: 0.14 }, { x: 0.64, y: 0.14 }, { x: 0.78, y: 0.9 }, { x: 0.22, y: 0.9 }];
const wide = [{ x: 0.08, y: 0.25 }, { x: 0.9, y: 0.2 }, { x: 0.92, y: 0.74 }, { x: 0.1, y: 0.8 }];

const cases = [
  ['rakt på mörkt bord', upright, dark, {}],
  ['snett på mörkt bord', tilted, dark, {}],
  ['perspektiv på mörkt bord', perspective, dark, {}],
  ['snett på träbord', tilted, wood, {}],
  ['perspektiv på träbord', perspective, wood, {}],
  ['snett på ljust bord', tilted, lightTable, { paper: 245 }],
  ['liggande kvitto', wide, dark, {}],
  ['skugga över bordet', tilted, shaded, {}],
  ['skugga över papperet', perspective, dark, { shadow: 60 }],
];

let failed = 0;
for (const [name, quad, background, options] of cases) {
  const image = photo({ width: 384, height: 512, quad, background, ...options });
  const found = findCorners(image);
  try {
    assert.ok(found, 'inga hörn hittades');
    const worst = Math.max(...orderCorners(quad).map((corner, i) => (
      Math.hypot((corner.x - found[i].x) * 384, (corner.y - found[i].y) * 512))));
    assert.ok(worst < 8, `hörnen är fel med ${worst.toFixed(1)} px`);
    console.log(`ok   ${name} (${worst.toFixed(1)} px)`);
  } catch (error) {
    failed += 1;
    console.log(`FEL  ${name}: ${error.message}`);
  }
}

// Nothing receipt-like: the app must leave these photos alone.
const blank = photo({ width: 384, height: 512, quad: [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }], background: wood });
assert.equal(findCorners(blank), null, 'tomt bord ska inte ge hörn');
const fullPage = photo({ width: 384, height: 512, quad: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }], background: dark });
assert.equal(findCorners(fullPage), null, 'en redan beskuren bild ska lämnas');

const bands = photo({ width: 384, height: 512, quad: [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }], background: (x, y, random) => (y > 110 && y < 180 ? 200 : 70) + random() * 6 });
assert.equal(findCorners(bands), null, 'en ljus rand över hela bordet är inget kvitto');

// The corners come back in reading order, whichever order they arrive in.
assert.deepEqual(orderCorners([tilted[2], tilted[0], tilted[3], tilted[1]]), tilted);

assert.equal(isUsableQuad(tilted), true);
assert.equal(isUsableQuad([tilted[0], tilted[2], tilted[1], tilted[3]]), false, 'korsade hörn');

// Straightening: a white quad on black becomes a nearly all-white image with the right shape.
{
  const width = 300;
  const height = 400;
  const px = perspective.map((p) => ({ x: p.x * width, y: p.y * height }));
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const value = inside(px, x + 0.5, y + 0.5) ? 255 : 0;
      data.fill(value, (y * width + x) * 4, (y * width + x) * 4 + 3);
      data[(y * width + x) * 4 + 3] = 255;
    }
  }
  const size = outputSize(px, 2000);
  assert.ok(size.height > size.width, 'kvittot ska vara högre än brett');
  const output = warp({ data, width, height }, px, size.width, size.height);
  let white = 0;
  for (let i = 0; i < output.length; i += 4) if (output[i] > 200) white += 1;
  assert.ok(white / (size.width * size.height) > 0.98, 'uträtad bild ska bara innehålla papper');
  assert.deepEqual(outputSize([{ x: 0, y: 0 }, { x: 1000, y: 0 }, { x: 1000, y: 4000 }, { x: 0, y: 4000 }], 2000), { width: 500, height: 2000 });
}

if (failed) {
  console.log(`\n${failed} av ${cases.length} misslyckades`);
  process.exit(1);
}
console.log(`\nAlla ${cases.length} foton och övriga kontroller klarade`);
