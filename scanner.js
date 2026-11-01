// Finds a receipt in a photo and straightens it. Works on raw pixels, so it needs no browser and no library.

const WORK_SIDE = 512;
const MIN_AREA = 0.03;
const MAX_AREA = 0.94;
const MIN_FILL = 0.72;
const MAX_BORDER_TOUCH = 0.03;

function toGray({ data, width, height }) {
  const gray = new Uint8Array(width * height);
  for (let i = 0; i < gray.length; i += 1) {
    gray[i] = (data[i * 4] * 299 + data[i * 4 + 1] * 587 + data[i * 4 + 2] * 114) / 1000;
  }
  return gray;
}

/** Box blur, run twice, which takes out paper grain and printed text but keeps the edge of the paper. */
function blur(source, width, height, radius) {
  let current = source;
  for (let pass = 0; pass < 2; pass += 1) {
    const across = new Uint8Array(current.length);
    const down = new Uint8Array(current.length);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        let sum = 0;
        let count = 0;
        for (let d = -radius; d <= radius; d += 1) {
          const nx = x + d;
          if (nx >= 0 && nx < width) { sum += current[y * width + nx]; count += 1; }
        }
        across[y * width + x] = sum / count;
      }
    }
    for (let x = 0; x < width; x += 1) {
      for (let y = 0; y < height; y += 1) {
        let sum = 0;
        let count = 0;
        for (let d = -radius; d <= radius; d += 1) {
          const ny = y + d;
          if (ny >= 0 && ny < height) { sum += across[ny * width + x]; count += 1; }
        }
        down[y * width + x] = sum / count;
      }
    }
    current = down;
  }
  return current;
}

function otsu(values) {
  const histogram = new Uint32Array(256);
  for (const value of values) histogram[value] += 1;
  let total = 0;
  for (let i = 0; i < 256; i += 1) total += i * histogram[i];
  let below = 0;
  let belowSum = 0;
  let best = 0;
  let threshold = 127;
  for (let i = 0; i < 256; i += 1) {
    below += histogram[i];
    if (!below) continue;
    const above = values.length - below;
    if (!above) break;
    belowSum += i * histogram[i];
    const difference = belowSum / below - (total - belowSum) / above;
    const variance = below * above * difference * difference;
    if (variance > best) { best = variance; threshold = i; }
  }
  return threshold;
}

/** Grows (value 1) or shrinks (value 0) the set pixels of a mask. */
function morph(mask, width, height, radius, value) {
  const result = mask.slice();
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (mask[y * width + x] !== value) continue;
      for (let dy = -radius; dy <= radius; dy += 1) {
        for (let dx = -radius; dx <= radius; dx += 1) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx >= 0 && nx < width && ny >= 0 && ny < height) result[ny * width + nx] = value;
        }
      }
    }
  }
  return result;
}

/** Everything that cannot be reached from the image border without crossing an edge. */
function enclosedByEdges(gray, width, height) {
  const strength = new Uint8Array(gray.length);
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const i = y * width + x;
      const gx = gray[i + 1] - gray[i - 1];
      const gy = gray[i + width] - gray[i - width];
      strength[i] = Math.min(255, Math.abs(gx) + Math.abs(gy));
    }
  }
  const cut = Math.max(6, otsu(strength) * 0.6);
  let wall = new Uint8Array(gray.length);
  for (let i = 0; i < gray.length; i += 1) wall[i] = strength[i] > cut ? 1 : 0;
  wall = morph(wall, width, height, 1, 1);

  const outside = new Uint8Array(gray.length);
  const stack = [];
  const visit = (i) => {
    if (!wall[i] && !outside[i]) { outside[i] = 1; stack.push(i); }
  };
  for (let x = 0; x < width; x += 1) { visit(x); visit((height - 1) * width + x); }
  for (let y = 0; y < height; y += 1) { visit(y * width); visit(y * width + width - 1); }
  while (stack.length) {
    const i = stack.pop();
    const x = i % width;
    if (x > 0) visit(i - 1);
    if (x < width - 1) visit(i + 1);
    if (i >= width) visit(i - width);
    if (i < gray.length - width) visit(i + width);
  }
  const inside = new Uint8Array(gray.length);
  for (let i = 0; i < gray.length; i += 1) inside[i] = outside[i] ? 0 : 1;
  // The walls are about three pixels thick, and the paper should not include them.
  return morph(inside, width, height, 3, 0);
}

function components(mask, width, height) {
  const seen = new Uint8Array(mask.length);
  const found = [];
  for (let start = 0; start < mask.length; start += 1) {
    if (!mask[start] || seen[start]) continue;
    const pixels = [];
    const stack = [start];
    seen[start] = 1;
    let touching = 0;
    while (stack.length) {
      const i = stack.pop();
      pixels.push(i);
      const x = i % width;
      const y = (i - x) / width;
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) touching += 1;
      const neighbours = [x > 0 ? i - 1 : -1, x < width - 1 ? i + 1 : -1, y > 0 ? i - width : -1, y < height - 1 ? i + width : -1];
      for (const next of neighbours) {
        if (next >= 0 && mask[next] && !seen[next]) { seen[next] = 1; stack.push(next); }
      }
    }
    found.push({ pixels, touching });
  }
  return found;
}

function cross(o, a, b) {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

function convexHull(points) {
  const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  const half = (list) => {
    const chain = [];
    for (const point of list) {
      while (chain.length >= 2 && cross(chain[chain.length - 2], chain[chain.length - 1], point) <= 0) chain.pop();
      chain.push(point);
    }
    chain.pop();
    return chain;
  };
  return [...half(sorted), ...half(sorted.reverse())];
}

/** The largest four-cornered shape with its corners on the hull. For a sheet of paper those are its corners. */
function largestQuad(hull) {
  const n = hull.length;
  let best = null;
  let bestArea = 0;
  for (let a = 0; a < n; a += 1) {
    for (let c = a + 2; c < n; c += 1) {
      let left = 0;
      let leftPoint = -1;
      for (let b = a + 1; b < c; b += 1) {
        const area = Math.abs(cross(hull[a], hull[c], hull[b]));
        if (area > left) { left = area; leftPoint = b; }
      }
      let right = 0;
      let rightPoint = -1;
      for (let d = c + 1; d < n + a; d += 1) {
        const area = Math.abs(cross(hull[a], hull[c], hull[d % n]));
        if (area > right) { right = area; rightPoint = d % n; }
      }
      if (leftPoint < 0 || rightPoint < 0) continue;
      const area = (left + right) / 2;
      if (area > bestArea) {
        bestArea = area;
        best = [hull[a], hull[leftPoint], hull[c], hull[rightPoint]];
      }
    }
  }
  return best && { corners: best, area: bestArea };
}

function bestCandidate(mask, width, height) {
  const imageArea = width * height;
  let best = null;
  for (const { pixels, touching } of components(mask, width, height)) {
    if (pixels.length < imageArea * MIN_AREA) continue;
    if (touching > (width + height) * 2 * MAX_BORDER_TOUCH) continue;

    // Only the outermost pixels of each row can be on the hull, which keeps it fast.
    const rows = new Map();
    for (const i of pixels) {
      const x = i % width;
      const y = (i - x) / width;
      const row = rows.get(y);
      if (!row) rows.set(y, { min: x, max: x });
      else { row.min = Math.min(row.min, x); row.max = Math.max(row.max, x); }
    }
    const edge = [];
    for (const [y, { min, max }] of rows) edge.push({ x: min, y }, { x: max + 1, y }, { x: min, y: y + 1 }, { x: max + 1, y: y + 1 });
    const quad = largestQuad(convexHull(edge));
    if (!quad || quad.area > imageArea * MAX_AREA) continue;
    const fill = pixels.length / quad.area;
    if (fill < MIN_FILL) continue;
    const score = Math.min(1, fill) * Math.sqrt(quad.area / imageArea);
    if (!best || score > best.score) best = { corners: quad.corners, score };
  }
  return best;
}

/** Corners as top left, top right, bottom right, bottom left, with the top edge the one closest to level. */
export function orderCorners(points) {
  const centre = {
    x: points.reduce((sum, p) => sum + p.x, 0) / points.length,
    y: points.reduce((sum, p) => sum + p.y, 0) / points.length,
  };
  const clockwise = [...points].sort((a, b) => Math.atan2(a.y - centre.y, a.x - centre.x) - Math.atan2(b.y - centre.y, b.x - centre.x));
  let start = 0;
  let closest = Infinity;
  for (let i = 0; i < 4; i += 1) {
    const next = clockwise[(i + 1) % 4];
    const angle = Math.abs(Math.atan2(next.y - clockwise[i].y, next.x - clockwise[i].x));
    if (angle < closest) { closest = angle; start = i; }
  }
  return [0, 1, 2, 3].map((offset) => clockwise[(start + offset) % 4]);
}

/** False when the corners have been dragged across each other or into a sliver. */
export function isUsableQuad(corners) {
  let sign = 0;
  for (let i = 0; i < 4; i += 1) {
    const turn = cross(corners[i], corners[(i + 1) % 4], corners[(i + 2) % 4]);
    if (Math.abs(turn) < 1e-4) return false;
    if (sign && Math.sign(turn) !== sign) return false;
    sign = Math.sign(turn);
  }
  return true;
}

/**
 * Looks for the receipt in an image, given as { data: RGBA, width, height } at about WORK_SIDE pixels.
 * Returns four corners as fractions of the image, or null if nothing looks like a sheet of paper.
 */
export function findCorners(image) {
  const { width, height } = image;
  const gray = blur(toGray(image), width, height, 1);

  const threshold = otsu(gray);
  let bright = new Uint8Array(gray.length);
  for (let i = 0; i < gray.length; i += 1) bright[i] = gray[i] > threshold ? 1 : 0;
  // Closing fills the printed text, so that the paper becomes one solid shape.
  bright = morph(morph(bright, width, height, 3, 1), width, height, 3, 0);

  const candidates = [bestCandidate(bright, width, height), bestCandidate(enclosedByEdges(gray, width, height), width, height)];
  const best = candidates.filter(Boolean).sort((a, b) => b.score - a.score)[0];
  if (!best) return null;
  return orderCorners(best.corners.map((p) => ({ x: p.x / width, y: p.y / height })));
}

export { WORK_SIDE };

/** Output size in pixels for corners given in pixels, capped at maxSide, from the lengths of the opposite sides. */
export function outputSize(corners, maxSide) {
  const length = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const [tl, tr, br, bl] = corners;
  const width = (length(tl, tr) + length(bl, br)) / 2;
  const height = (length(tl, bl) + length(tr, br)) / 2;
  const scale = Math.min(1, maxSide / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** The transform that takes the unit square to the four corners. */
function squareToQuad([p0, p1, p2, p3]) {
  const dx1 = p1.x - p2.x;
  const dx2 = p3.x - p2.x;
  const sx = p0.x - p1.x + p2.x - p3.x;
  const dy1 = p1.y - p2.y;
  const dy2 = p3.y - p2.y;
  const sy = p0.y - p1.y + p2.y - p3.y;
  const denominator = dx1 * dy2 - dx2 * dy1;
  const g = (sx * dy2 - dx2 * sy) / denominator;
  const h = (dx1 * sy - sx * dy1) / denominator;
  return {
    a: p1.x - p0.x + g * p1.x,
    b: p3.x - p0.x + h * p3.x,
    c: p0.x,
    d: p1.y - p0.y + g * p1.y,
    e: p3.y - p0.y + h * p3.y,
    f: p0.y,
    g,
    h,
  };
}

/** Straightens the area inside the corners (in pixels) into a width × height image. Returns RGBA pixels. */
export function warp(source, corners, width, height) {
  const { a, b, c, d, e, f, g, h } = squareToQuad(corners);
  const { data, width: sw, height: sh } = source;
  const output = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const v = (y + 0.5) / height;
    for (let x = 0; x < width; x += 1) {
      const u = (x + 0.5) / width;
      const w = g * u + h * v + 1;
      const sourceX = Math.min(sw - 1.001, Math.max(0, (a * u + b * v + c) / w - 0.5));
      const sourceY = Math.min(sh - 1.001, Math.max(0, (d * u + e * v + f) / w - 0.5));
      const x0 = Math.floor(sourceX);
      const y0 = Math.floor(sourceY);
      const fx = sourceX - x0;
      const fy = sourceY - y0;
      const top = (y0 * sw + x0) * 4;
      const bottom = top + sw * 4;
      const target = (y * width + x) * 4;
      for (let channel = 0; channel < 3; channel += 1) {
        output[target + channel] = (data[top + channel] * (1 - fx) + data[top + 4 + channel] * fx) * (1 - fy)
          + (data[bottom + channel] * (1 - fx) + data[bottom + 4 + channel] * fx) * fy;
      }
      output[target + 3] = 255;
    }
  }
  return output;
}
