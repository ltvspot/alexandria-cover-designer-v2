// quality.js — Client-side quality scoring with circular composition heuristics

// ---------------------------------------------------------------------------
// Low-level math helpers
// ---------------------------------------------------------------------------

function variance(values) {
  if (values.length === 0) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
}

function stddev(values) {
  return Math.sqrt(variance(values));
}

// ---------------------------------------------------------------------------
// Sub-score A — Edge Content Penalty (weight 0.25)
// Measures how much high-contrast detail appears near the circular boundary
// vs. in the centre.  Lots of edge detail near the boundary = content being
// cropped = low score.
// ---------------------------------------------------------------------------

function edgeContentScore(imageElement) {
  const canvas = document.createElement('canvas');
  const size = 200; // work at low res for speed
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(imageElement, 0, 0, size, size);
  const data = ctx.getImageData(0, 0, size, size).data;

  const cx = size / 2, cy = size / 2, r = size / 2;
  let edgeDetail = 0, edgeCount = 0;
  let centerDetail = 0, centerCount = 0;

  // Compare each pixel to its right/down neighbour to detect edges
  for (let y = 1; y < size - 1; y++) {
    for (let x = 1; x < size - 1; x++) {
      const dist = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
      if (dist > r) continue; // outside circle, skip

      const idx      = (y * size + x) * 4;
      const rightIdx = (y * size + x + 1) * 4;
      const downIdx  = ((y + 1) * size + x) * 4;

      // Simplified Sobel-like gradient magnitude
      const gradX = Math.abs(data[idx]   - data[rightIdx])
                  + Math.abs(data[idx+1] - data[rightIdx+1])
                  + Math.abs(data[idx+2] - data[rightIdx+2]);
      const gradY = Math.abs(data[idx]   - data[downIdx])
                  + Math.abs(data[idx+1] - data[downIdx+1])
                  + Math.abs(data[idx+2] - data[downIdx+2]);
      const edgeMag = (gradX + gradY) / 6; // normalise to 0-255

      if (dist > r * 0.85) {       // outer 15% annular ring
        edgeDetail += edgeMag;
        edgeCount++;
      } else if (dist < r * 0.5) { // inner 50% centre circle
        centerDetail += edgeMag;
        centerCount++;
      }
    }
  }

  if (edgeCount === 0 || centerCount === 0) return 0.5;

  const avgEdge   = edgeDetail / edgeCount;
  const avgCenter = centerDetail / centerCount;

  // Good: edge ring detail is LOW relative to centre detail
  // Bad:  edge ring detail is HIGH (subject being cropped at the boundary)
  // ratio < 0.5 = great, ratio > 1.5 = terrible
  const ratio = avgCenter > 0 ? avgEdge / avgCenter : 1;
  return Math.max(0, Math.min(1, 1.5 - ratio));
}

function centerOfMassScore(imageElement) {
  const canvas = document.createElement('canvas');
  const size = 150;
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(imageElement, 0, 0, size, size);
  const data = ctx.getImageData(0, 0, size, size).data;

  let totalWeight = 0, weightedX = 0, weightedY = 0;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;
      const r = data[idx], g = data[idx+1], b = data[idx+2];
      const brightness  = (r + g + b) / 3;
      const maxC = Math.max(r, g, b), minC = Math.min(r, g, b);
      const saturation  = maxC > 0 ? (maxC - minC) / maxC : 0;
      const weight = brightness * (0.5 + saturation * 0.5);

      totalWeight += weight;
      weightedX   += x * weight;
      weightedY   += y * weight;
    }
  }

  if (totalWeight === 0) return 0.5;

  const comX = weightedX / totalWeight;
  const comY = weightedY / totalWeight;
  const cx = size / 2, cy = size / 2;

  const dist = Math.sqrt((comX - cx) ** 2 + (comY - cy) ** 2) / (size / 2);
  return Math.max(0, Math.min(1, 1 - dist * 2));
}

function circularCompositionScore(imageElement) {
  const canvas = document.createElement('canvas');
  const size = 150;
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(imageElement, 0, 0, size, size);
  const data = ctx.getImageData(0, 0, size, size).data;

  const cx = size / 2, cy = size / 2, r = size / 2;
  const insideValues = [], outsideValues = [];

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx        = (y * size + x) * 4;
      const brightness = data[idx] * 0.299 + data[idx+1] * 0.587 + data[idx+2] * 0.114;
      const dist       = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);

      if (dist < r * 0.7) {
        insideValues.push(brightness);
      } else {
        outsideValues.push(brightness);
      }
    }
  }

  const insideStd  = stddev(insideValues);
  const outsideStd = stddev(outsideValues);

  if (insideStd + outsideStd === 0) return 0.5;
  const ratio = insideStd / (insideStd + outsideStd);
  return Math.max(0, Math.min(1, (ratio - 0.3) * 3.33));
}

function scoreImage(canvas) {
  const ctx = canvas.getContext('2d');
  const sampleSize = Math.min(canvas.width, 400);
  const scale = sampleSize / canvas.width;

  const sampleCanvas = document.createElement('canvas');
  sampleCanvas.width  = sampleSize;
  sampleCanvas.height = Math.round(canvas.height * scale);
  const sctx = sampleCanvas.getContext('2d');
  sctx.drawImage(canvas, 0, 0, sampleCanvas.width, sampleCanvas.height);

  const imageData  = sctx.getImageData(0, 0, sampleCanvas.width, sampleCanvas.height);
  const data       = imageData.data;

  let totalR = 0, totalG = 0, totalB = 0;
  let totalBrightness = 0;
  const brightnesses = [];
  const rValues = [], gValues = [], bValues = [];

  const step = 4;
  let sampledCount = 0;

  for (let i = 0; i < data.length; i += 4 * step) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const brightness = (r * 0.299 + g * 0.587 + b * 0.114) / 255;

    totalR          += r;
    totalG          += g;
    totalB          += b;
    totalBrightness += brightness;
    brightnesses.push(brightness);
    rValues.push(r);
    gValues.push(g);
    bValues.push(b);
    sampledCount++;
  }

  if (sampledCount === 0) return 0;

  const avgBrightness = totalBrightness / sampledCount;
  const avgR = totalR / sampledCount;
  const avgG = totalG / sampledCount;
  const avgB = totalB / sampledCount;

  const colorVarianceR = variance(rValues);
  const colorVarianceG = variance(gValues);
  const colorVarianceB = variance(bValues);
  const totalColorVariance = (colorVarianceR + colorVarianceG + colorVarianceB) / 3;
  const colorScore     = Math.min(1, totalColorVariance / 2000);
  const brightnessScore = Math.max(0, 1 - Math.abs(avgBrightness - 0.45) * 2);
  const contrastScore  = Math.min(1, Math.sqrt(variance(brightnesses)) / 0.25);
  const channelSpread  = Math.abs(avgR - avgG) + Math.abs(avgG - avgB) + Math.abs(avgR - avgB);
  const diversityScore = Math.min(1, channelSpread / 200);

  return Math.max(0, Math.min(1,
    colorScore    * 0.35 +
    brightnessScore * 0.25 +
    contrastScore * 0.25 +
    diversityScore * 0.15
  ));
}

function _legacyColorScores(imageElement) {
  const canvas = document.createElement('canvas');
  const maxSize = 300;
  const scale   = Math.min(maxSize / imageElement.width, maxSize / imageElement.height, 1);
  canvas.width  = Math.round(imageElement.width  * scale);
  canvas.height = Math.round(imageElement.height * scale);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(imageElement, 0, 0, canvas.width, canvas.height);

  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;

  let totalR = 0, totalG = 0, totalB = 0, totalBrightness = 0;
  const brightnesses = [], rValues = [], gValues = [], bValues = [];
  const step = 4;
  let sampledCount = 0;

  for (let i = 0; i < data.length; i += 4 * step) {
    const r = data[i], g = data[i+1], b = data[i+2];
    const brightness = (r * 0.299 + g * 0.587 + b * 0.114) / 255;
    totalR += r; totalG += g; totalB += b;
    totalBrightness += brightness;
    brightnesses.push(brightness);
    rValues.push(r); gValues.push(g); bValues.push(b);
    sampledCount++;
  }

  if (sampledCount === 0) return { colorScore: 0.5, brightnessScore: 0.5, contrastScore: 0.5, diversityScore: 0.5 };

  const avgBrightness = totalBrightness / sampledCount;
  const avgR = totalR / sampledCount;
  const avgG = totalG / sampledCount;
  const avgB = totalB / sampledCount;

  const totalColorVariance = (variance(rValues) + variance(gValues) + variance(bValues)) / 3;
  const colorScore      = Math.min(1, totalColorVariance / 2000);
  const brightnessScore = Math.max(0, 1 - Math.abs(avgBrightness - 0.45) * 2);
  const contrastScore   = Math.min(1, Math.sqrt(variance(brightnesses)) / 0.25);
  const channelSpread   = Math.abs(avgR - avgG) + Math.abs(avgG - avgB) + Math.abs(avgR - avgB);
  const diversityScore  = Math.min(1, channelSpread / 200);

  return { colorScore, brightnessScore, contrastScore, diversityScore };
}

function scoreGeneratedImage(imageElement) {
  const { colorScore, brightnessScore, contrastScore, diversityScore } = _legacyColorScores(imageElement);

  const ecScore  = edgeContentScore(imageElement);
  const comScore = centerOfMassScore(imageElement);
  const ccScore  = circularCompositionScore(imageElement);

  const finalScore = (
    ecScore        * 0.25 +
    comScore       * 0.20 +
    ccScore        * 0.20 +
    colorScore     * 0.12 +
    brightnessScore * 0.08 +
    contrastScore  * 0.08 +
    diversityScore * 0.07
  );

  return Math.max(0, Math.min(1, finalScore));
}

function getDetailedScores(imageElement) {
  const { colorScore, brightnessScore, contrastScore, diversityScore } = _legacyColorScores(imageElement);

  const ecScore  = edgeContentScore(imageElement);
  const comScore = centerOfMassScore(imageElement);
  const ccScore  = circularCompositionScore(imageElement);

  const overall = Math.max(0, Math.min(1,
    ecScore        * 0.25 +
    comScore       * 0.20 +
    ccScore        * 0.20 +
    colorScore     * 0.12 +
    brightnessScore * 0.08 +
    contrastScore  * 0.08 +
    diversityScore * 0.07
  ));

  return {
    overall,
    edgeContent:          { score: ecScore,         weight: 0.25 },
    centerOfMass:         { score: comScore,        weight: 0.20 },
    circularComposition:  { score: ccScore,         weight: 0.20 },
    color:                { score: colorScore,      weight: 0.12 },
    brightness:           { score: brightnessScore, weight: 0.08 },
    contrast:             { score: contrastScore,   weight: 0.08 },
    diversity:            { score: diversityScore,  weight: 0.07 }
  };
}

window.Quality = { scoreImage, scoreGeneratedImage, getDetailedScores };