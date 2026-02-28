// compositor.js — Canvas-based compositing with clean medallion replacement
//
// ARCHITECTURE (v3 — Guaranteed clean compositing):
//   1. Fill canvas with the cover's background color
//   2. Draw the generated illustration, clipped to a circle that fills
//      the ENTIRE medallion area (including where old artwork was)
//   3. Draw a synthetic beveled gold ring border around the illustration
//   4. Overlay the original cover with a big punch (removes the entire
//      medallion zone including ALL old artwork and frame elements)
//
// This approach GUARANTEES zero bleed of old pre-existing artwork
// because the entire medallion zone (illustration + frame + old art)
// is replaced. The synthetic gold ring provides the visual border.
//
// WHY: The original covers have old artwork baked into the JPG that
// is chromatically identical to the gold ornaments. No color-based
// detection can separate them. This approach side-steps the problem
// entirely by replacing the whole zone.

// The illustration fills to this ratio of the detected outer radius.
// With detected radius ~520, this gives ~645px which covers the
// inner frame zone while staying just inside the outermost scrollwork.
const ILLUSTRATION_RATIO = 1.24;

// The cover punch removes everything inside this ratio.
// Slightly larger than ILLUSTRATION_RATIO to create a clean edge.
const PUNCH_RATIO = 1.26;

// Gold ring sits at the illustration edge
const RING_WIDTH = 14;  // pixels

// ---------------------------------------------------------------------------
// findBestCropCenter — energy-based detail center detection
// Returns {x, y} in 0-1 normalised coords
// ---------------------------------------------------------------------------
function findBestCropCenter(imageElement) {
  const size = 150;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(imageElement, 0, 0, size, size);
  const data = ctx.getImageData(0, 0, size, size).data;

  const energy = new Float32Array(size * size);
  for (let y = 1; y < size - 1; y++) {
    for (let x = 1; x < size - 1; x++) {
      const idx   = (y * size + x) * 4;
      const right = (y * size + x + 1) * 4;
      const down  = ((y + 1) * size + x) * 4;
      const gx = Math.abs(data[idx] - data[right]) +
                 Math.abs(data[idx + 1] - data[right + 1]) +
                 Math.abs(data[idx + 2] - data[right + 2]);
      const gy = Math.abs(data[idx] - data[down]) +
                 Math.abs(data[idx + 1] - data[down + 1]) +
                 Math.abs(data[idx + 2] - data[down + 2]);
      energy[y * size + x] = (gx + gy) / 6;
    }
  }

  const blurred = new Float32Array(size * size);
  const kernel = [1, 2, 1, 2, 4, 2, 1, 2, 1];
  const kSum = 16;
  for (let y = 1; y < size - 1; y++) {
    for (let x = 1; x < size - 1; x++) {
      let v = 0, ki = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          v += energy[(y + dy) * size + (x + dx)] * kernel[ki++];
        }
      }
      blurred[y * size + x] = v / kSum;
    }
  }

  let totalW = 0, wx = 0, wy = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const w = blurred[y * size + x];
      totalW += w;
      wx += x * w;
      wy += y * w;
    }
  }

  if (totalW === 0) return { x: 0.5, y: 0.5 };
  return { x: (wx / totalW) / size, y: (wy / totalW) / size };
}

// ---------------------------------------------------------------------------
// sampleBackgroundColor — detect the cover's navy/dark background color
// by sampling pixels well outside the medallion zone
// ---------------------------------------------------------------------------
function sampleBackgroundColor(coverImg, cx, cy) {
  const size = 100;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(coverImg, 0, 0, size, size);
  const data = ctx.getImageData(0, 0, size, size).data;

  // Sample from corners of the right half (front cover area)
  // These should be the background color
  const samples = [];
  const W = coverImg.width;
  const H = coverImg.height;

  // Map medallion center to sample coordinates
  const sCx = Math.round(cx / W * size);
  const sCy = Math.round(cy / H * size);

  // Sample at four points far from the medallion center
  const samplePoints = [
    [sCx, 5],                    // Top center of front cover
    [sCx, size - 5],             // Bottom center of front cover
    [Math.min(size - 5, sCx + 30), sCy], // Right of medallion
    [Math.max(5, sCx - 30), sCy],        // Left of medallion (still on front)
  ];

  for (const [sx, sy] of samplePoints) {
    const idx = (sy * size + sx) * 4;
    samples.push([data[idx], data[idx + 1], data[idx + 2]]);
  }

  // Take median to avoid outliers (text, ornaments)
  // Actually, take the DARKEST sample — the background is always the darkest element
  samples.sort((a, b) => (a[0] + a[1] + a[2]) - (b[0] + b[1] + b[2]));
  return samples[0]; // Darkest sample
}

// ---------------------------------------------------------------------------
// compositeOnCover — backward compat wrapper
// ---------------------------------------------------------------------------
function compositeOnCover(coverImg, generatedImg, cx = 2850, cy = 1350, radius = 520, feather = 15) {
  return smartComposite(coverImg, generatedImg, cx, cy, radius);
}

// ---------------------------------------------------------------------------
// smartComposite — the clean compositing pipeline
// ---------------------------------------------------------------------------
function smartComposite(coverImg, generatedImg, cx = 2850, cy = 1350, radius = 520) {
  const illustrationRadius = Math.round(radius * ILLUSTRATION_RATIO);
  const punchRadius = Math.round(radius * PUNCH_RATIO);

  console.log(`[Compositor] detected_radius=${radius}, illustration_r=${illustrationRadius}, punch_r=${punchRadius}`);

  const detailCenter = findBestCropCenter(generatedImg);
  const clampedX = Math.max(0.2, Math.min(0.8, detailCenter.x));
  const clampedY = Math.max(0.2, Math.min(0.8, detailCenter.y));

  return _cleanComposite(coverImg, generatedImg, cx, cy,
    illustrationRadius, punchRadius, clampedX, clampedY);
}

// ---------------------------------------------------------------------------
// _cleanComposite — guaranteed clean, no gold detection needed
//
//   Layer 0: Background color (sampled from cover)
//   Layer 1: Illustration clipped to illustrationRadius circle
//   Layer 2: Gold ring border at illustration edge
//   Layer 3: Cover with everything inside punchRadius removed
// ---------------------------------------------------------------------------
function _cleanComposite(coverImg, generatedImg, cx, cy,
  illustrationRadius, punchRadius, cropCenterX, cropCenterY) {

  const W = coverImg.width || 3784;
  const H = coverImg.height || 2777;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');

  // === SAMPLE BACKGROUND COLOR ===
  const bgColor = sampleBackgroundColor(coverImg, cx, cy);
  const bgR = bgColor[0], bgG = bgColor[1], bgB = bgColor[2];

  // === LAYER 0: Background fill ===
  ctx.fillStyle = `rgb(${bgR},${bgG},${bgB})`;
  ctx.fillRect(0, 0, W, H);

  // === LAYER 1: Illustration clipped to illustrationRadius ===
  const size = illustrationRadius * 2;
  const imgW = generatedImg.width;
  const imgH = generatedImg.height;

  // Aspect-fill square crop
  let srcW, srcH;
  if (imgW > imgH) { srcH = imgH; srcW = imgH; }
  else { srcW = imgW; srcH = imgW; }

  let srcX = Math.round(cropCenterX * imgW - srcW / 2);
  let srcY = Math.round(cropCenterY * imgH - srcH / 2);
  srcX = Math.max(0, Math.min(imgW - srcW, srcX));
  srcY = Math.max(0, Math.min(imgH - srcH, srcY));

  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, illustrationRadius, 0, Math.PI * 2);
  ctx.closePath();
  ctx.clip();
  ctx.drawImage(generatedImg,
    srcX, srcY, srcW, srcH,
    cx - illustrationRadius, cy - illustrationRadius, size, size
  );
  ctx.restore();

  // === LAYER 2: Beveled gold ring border ===
  _drawGoldRing(ctx, cx, cy, illustrationRadius, RING_WIDTH);

  // === LAYER 3: Cover with punch ===
  // Create a temporary canvas with the cover, punch a hole, composite on top
  const coverCanvas = document.createElement('canvas');
  coverCanvas.width = W;
  coverCanvas.height = H;
  const cctx = coverCanvas.getContext('2d');
  cctx.drawImage(coverImg, 0, 0, W, H);

  // Punch out the entire medallion zone
  cctx.globalCompositeOperation = 'destination-out';
  cctx.beginPath();
  cctx.arc(cx, cy, punchRadius, 0, Math.PI * 2);
  cctx.closePath();
  cctx.fill();
  cctx.globalCompositeOperation = 'source-over';

  // Composite punched cover on top
  ctx.drawImage(coverCanvas, 0, 0);

  return canvas;
}

// ---------------------------------------------------------------------------
// _drawGoldRing — draw a beveled metallic gold ring using radial gradient
// ---------------------------------------------------------------------------
function _drawGoldRing(ctx, cx, cy, radius, width) {
  const halfW = width / 2;
  const outerR = radius + halfW;
  const innerR = radius - halfW;

  // Draw the ring using a series of thin concentric circles
  // with color varying from dark (edges) to bright (center) for a beveled look
  for (let i = 0; i <= width; i++) {
    const r = innerR + i;
    const t = i / width; // 0 = inner edge, 1 = outer edge

    // Bevel profile: dark edges, bright center band
    let brightness;
    if (t < 0.15) {
      brightness = 0.3 + t * 2.5; // Inner shadow → rising
    } else if (t < 0.45) {
      brightness = 0.7 + (t - 0.15) * 1.0; // Rising to peak
    } else if (t < 0.55) {
      brightness = 1.0; // Bright highlight band
    } else if (t < 0.85) {
      brightness = 1.0 - (t - 0.55) * 1.0; // Falling from peak
    } else {
      brightness = 0.7 - (t - 0.85) * 2.5; // Outer shadow
    }

    // Gold color modulated by brightness
    const gr = Math.round(Math.min(255, 210 * brightness));
    const gg = Math.round(Math.min(255, 170 * brightness));
    const gb = Math.round(Math.min(255, 70 * brightness));

    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.strokeStyle = `rgb(${gr},${gg},${gb})`;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  // Add subtle bead-like highlights at regular intervals
  const numBeads = 72;
  const beadRadius = Math.max(2, width * 0.25);
  for (let i = 0; i < numBeads; i++) {
    const angle = (2 * Math.PI * i) / numBeads;
    const bx = cx + radius * Math.cos(angle);
    const by = cy + radius * Math.sin(angle);

    // Bright gold highlight
    const grad = ctx.createRadialGradient(bx - 1, by - 1, 0, bx, by, beadRadius);
    grad.addColorStop(0, 'rgba(255, 235, 160, 0.8)');
    grad.addColorStop(0.5, 'rgba(210, 170, 70, 0.6)');
    grad.addColorStop(1, 'rgba(150, 120, 40, 0)');

    ctx.beginPath();
    ctx.arc(bx, by, beadRadius, 0, Math.PI * 2);
    ctx.fillStyle = grad;
    ctx.fill();
  }
}

// Create a thumbnail of a canvas
function createThumbnail(canvas, maxWidth = 400) {
  const scale = maxWidth / canvas.width;
  const thumbCanvas = document.createElement('canvas');
  thumbCanvas.width = maxWidth;
  thumbCanvas.height = Math.round(canvas.height * scale);
  const ctx = thumbCanvas.getContext('2d');
  ctx.drawImage(canvas, 0, 0, thumbCanvas.width, thumbCanvas.height);
  return thumbCanvas;
}

// Canvas to Blob
function canvasToBlob(canvas, type = 'image/jpeg', quality = 0.9) {
  return new Promise((resolve) => {
    canvas.toBlob(resolve, type, quality);
  });
}

// Canvas to data URL
function canvasToDataUrl(canvas, type = 'image/jpeg', quality = 0.9) {
  return canvas.toDataURL(type, quality);
}

window.Compositor = {
  compositeOnCover, smartComposite, findBestCropCenter,
  createThumbnail, canvasToBlob, canvasToDataUrl,
  ILLUSTRATION_RATIO, PUNCH_RATIO, RING_WIDTH
};