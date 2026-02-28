// drive.js — Google Drive API calls from browser

// Paginated folder listing — fetches ALL pages
async function listDriveSubfolders(folderId, apiKey) {
  let allFiles = [];
  let pageToken = null;

  do {
    let url = `https://www.googleapis.com/drive/v3/files?q='${folderId}'+in+parents+and+mimeType='application/vnd.google-apps.folder'+and+trashed=false&fields=nextPageToken,files(id,name)&pageSize=100&key=${apiKey}`;
    if (pageToken) url += `&pageToken=${encodeURIComponent(pageToken)}`;

    const r = await fetch(url);
    if (!r.ok) throw new Error(`Drive API error: ${r.status} ${r.statusText}`);
    const data = await r.json();
    if (data.error) throw new Error(data.error.message);

    allFiles = allFiles.concat(data.files || []);
    pageToken = data.nextPageToken || null;
  } while (pageToken);

  return allFiles;
}

async function listDriveFiles(folderId, apiKey) {
  const url = `https://www.googleapis.com/drive/v3/files?q='${folderId}'+in+parents+and+trashed=false&fields=files(id,name,mimeType,size)&pageSize=100&key=${apiKey}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Drive API error: ${r.status} ${r.statusText}`);
  const data = await r.json();
  if (data.error) throw new Error(data.error.message);
  return data.files || [];
}

function getDriveDownloadUrl(fileId, apiKey) {
  return `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&key=${apiKey}`;
}

function getDriveThumbnailUrl(fileId, apiKey, size = 220) {
  return `https://drive.google.com/thumbnail?id=${fileId}&sz=w${size}`;
}

// Parse book folder name: "142. The Carnivore — Katherine MacLean"
function parseBookFolder(folderName) {
  let number = '';
  let title = folderName;
  let author = '';

  const fullMatch = folderName.match(/^(\d+)\.\s+(.+?)\s+[—–]\s+(.+?)(?:\s+copy)?$/i);
  if (fullMatch) {
    number = fullMatch[1];
    title = fullMatch[2].trim();
    author = fullMatch[3].trim();
    return { number, title, author };
  }

  const numMatch = folderName.match(/^(\d+)\.\s+(.+)/);
  if (numMatch) {
    number = numMatch[1];
    title = numMatch[2].trim();
  }

  const dashMatch = title.match(/^(.+?)\s+[—–]\s+(.+)$/);
  if (dashMatch) {
    title = dashMatch[1].trim();
    author = dashMatch[2].trim();
  }

  return { number, title, author };
}

// Run promises in parallel with concurrency limit
async function parallelMap(items, fn, concurrency = 10) {
  const results = new Array(items.length);
  let idx = 0;

  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i], i);
    }
  }

  const workers = [];
  for (let w = 0; w < Math.min(concurrency, items.length); w++) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return results;
}

// Sync all books from Drive — with progress callback and parallel file lookups
async function syncCatalog(onProgress) {
  const apiKey = await window.DB.getSetting('google_api_key');
  const folderId = await window.DB.getSetting('drive_source_folder');
  if (!apiKey || !folderId) throw new Error('Google API key and Drive folder ID required');

  // Step 1: Get ALL subfolders (paginated)
  if (onProgress) onProgress('Listing folders...', 0, 0);
  const subfolders = await listDriveSubfolders(folderId, apiKey);
  const total = subfolders.length;
  if (onProgress) onProgress(`Found ${total} books, scanning covers...`, 0, total);

  let completed = 0;
  const books = [];

  // Step 2: Scan each folder for cover JPG in parallel (10 concurrent)
  await parallelMap(subfolders, async (folder) => {
    const { number, title, author } = parseBookFolder(folder.name);

    let coverFile = null;
    try {
      const files = await listDriveFiles(folder.id, apiKey);
      coverFile = files.find(f =>
        f.mimeType === 'image/jpeg' || f.name.toLowerCase().endsWith('.jpg') || f.name.toLowerCase().endsWith('.jpeg')
      );
    } catch (e) {
      // Skip folder on error, don't break entire sync
      console.warn(`Failed to list files in ${folder.name}:`, e.message);
    }

    const book = {
      id: folder.id,
      number,
      title,
      author,
      folder_name: folder.name,
      cover_jpg_id: coverFile ? coverFile.id : null,
      cover_file_name: coverFile ? coverFile.name : null,
      genre: '',
      themes: '',
      era: '',
      synced_at: new Date().toISOString()
    };
    books.push(book);
    await window.DB.dbPut('books', book);

    completed++;
    if (onProgress && completed % 20 === 0) {
      onProgress(`Scanned ${completed} of ${total}...`, completed, total);
    }
  }, 10);

  if (onProgress) onProgress(`Synced ${books.length} books`, books.length, total);
  return books;
}

// Download a cover image as an Image element
async function downloadCoverAsImage(fileId, apiKey) {
  const url = getDriveDownloadUrl(fileId, apiKey);
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = (e) => reject(new Error('Failed to load cover image'));
    img.src = url;
  });
}

// Download cover as blob
async function downloadCoverAsBlob(fileId, apiKey) {
  const url = getDriveDownloadUrl(fileId, apiKey);
  const resp = await fetch(url);
  if (!resp.ok) throw new Error('Failed to download cover');
  return await resp.blob();
}

// ---------------------------------------------------------------------------
// B4: Download cover with retry + timeout
// B7: CORS proxy fallback
// Tries up to 3 times with exponential backoff. Each attempt has a timeout.
// On CORS/network failure, falls back to fetching via blob URL workaround.
// ---------------------------------------------------------------------------
async function downloadCoverWithRetry(fileId, apiKey, maxRetries = 2, timeoutMs = 20000) {
  const url = getDriveDownloadUrl(fileId, apiKey);
  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      // Try direct Image load with timeout
      const img = await _loadImageWithTimeout(url, timeoutMs);
      console.log(`Cover downloaded on attempt ${attempt + 1} (${img.width}×${img.height})`);
      return img;
    } catch (e) {
      lastError = e;
      console.warn(`Cover download attempt ${attempt + 1} failed:`, e.message);

      // B7: On final retry, try fetch+blob approach (bypasses some CORS issues)
      if (attempt === maxRetries) {
        try {
          console.log('Trying blob fetch fallback...');
          const img = await _fetchAsBlob(url, timeoutMs);
          console.log(`Cover loaded via blob fallback (${img.width}×${img.height})`);
          return img;
        } catch (e2) {
          console.error('Blob fallback also failed:', e2.message);
        }
      }

      // Exponential backoff: 1s, 2s, 4s
      if (attempt < maxRetries) {
        const delay = 1000 * Math.pow(2, attempt);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }

  throw new Error(`Cover download failed after ${maxRetries + 1} attempts: ${lastError?.message || 'unknown'}`);
}

// Load an image with a timeout
function _loadImageWithTimeout(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';

    const timer = setTimeout(() => {
      img.src = ''; // Cancel load
      reject(new Error(`Image load timed out after ${Math.round(timeoutMs/1000)}s`));
    }, timeoutMs);

    img.onload = () => {
      clearTimeout(timer);
      resolve(img);
    };
    img.onerror = () => {
      clearTimeout(timer);
      reject(new Error('Image load failed (network/CORS error)'));
    };
    img.src = url;
  });
}

// B7: Fetch as blob and create object URL — bypasses some CORS restrictions
async function _fetchAsBlob(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resp = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const blob = await resp.blob();
    const objUrl = URL.createObjectURL(blob);
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Blob image load failed'));
      img.src = objUrl;
    });
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Cover Template Validation — detect medallion position from a cover image
// Uses radial brightness variance to find the circular medallion boundary.
// Returns { cx, cy, radius } in source-image coordinates, or null if no
// clear medallion is detected.
// ---------------------------------------------------------------------------
async function detectMedallionPosition(imageElement) {
  const size = 300; // analyse at reduced resolution for speed
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');

  // The covers are landscape wraparound (3784×2777).  The medallion sits
  // on the right half (the front cover).  Map the right 55% into our
  // analysis canvas to focus on the front.
  const srcX = Math.round(imageElement.width * 0.45);
  const srcW = imageElement.width - srcX;
  ctx.drawImage(imageElement, srcX, 0, srcW, imageElement.height, 0, 0, size, size);

  const data = ctx.getImageData(0, 0, size, size).data;

  // Build a brightness map
  const brightness = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;
      brightness[y * size + x] = data[idx] * 0.299 + data[idx + 1] * 0.587 + data[idx + 2] * 0.114;
    }
  }

  // Build a gradient-magnitude map (Sobel-like)
  const edge = new Float32Array(size * size);
  for (let y = 1; y < size - 1; y++) {
    for (let x = 1; x < size - 1; x++) {
      const gx = Math.abs(brightness[y * size + x + 1] - brightness[y * size + x - 1]);
      const gy = Math.abs(brightness[(y + 1) * size + x] - brightness[(y - 1) * size + x]);
      edge[y * size + x] = gx + gy;
    }
  }

  // Candidate search: test circles centred at a grid of points.
  // Score each candidate by the average edge magnitude on its perimeter.
  let bestScore = 0;
  let bestCx = size / 2, bestCy = size / 2, bestR = size * 0.35;

  const step = 8;  // grid step
  const rMin = Math.round(size * 0.2);
  const rMax = Math.round(size * 0.48);
  const rStep = 6;
  const numPerimeterSamples = 72; // sample 72 points on the circle

  for (let cy = rMin; cy < size - rMin; cy += step) {
    for (let cx = rMin; cx < size - rMin; cx += step) {
      for (let r = rMin; r <= rMax; r += rStep) {
        // Quick bounds check
        if (cx - r < 0 || cx + r >= size || cy - r < 0 || cy + r >= size) continue;

        let perimeterSum = 0;
        for (let i = 0; i < numPerimeterSamples; i++) {
          const angle = (2 * Math.PI * i) / numPerimeterSamples;
          const px = Math.round(cx + r * Math.cos(angle));
          const py = Math.round(cy + r * Math.sin(angle));
          if (px >= 0 && px < size && py >= 0 && py < size) {
            perimeterSum += edge[py * size + px];
          }
        }
        const score = perimeterSum / numPerimeterSamples;
        if (score > bestScore) {
          bestScore = score;
          bestCx = cx;
          bestCy = cy;
          bestR = r;
        }
      }
    }
  }

  // If best score is too low, there's no clear medallion boundary
  if (bestScore < 8) return null;

  // Map back from analysis coordinates to full-image coordinates
  const scaleX = srcW / size;
  const scaleY = imageElement.height / size;

  return {
    cx: Math.round(srcX + bestCx * scaleX),
    cy: Math.round(bestCy * scaleY),
    radius: Math.round(bestR * Math.min(scaleX, scaleY)),
    confidence: Math.min(1, bestScore / 40) // rough confidence 0-1
  };
}

// Validate a cover template — checks that the medallion area exists and
// returns the detected position (or the defaults if detection fails).
async function validateCoverTemplate(imageElement) {
  const detected = await detectMedallionPosition(imageElement);
  const defaults = { cx: 2850, cy: 1350, radius: 520, confidence: 0 };

  if (!detected || detected.confidence < 0.3) {
    return { valid: true, medallion: defaults, detected: false };
  }

  // Sanity check — detected position should be in the right half of the cover
  // and roughly in the expected zone
  const reasonable = detected.cx > 1500 && detected.cx < 3500 &&
                     detected.cy > 500 && detected.cy < 2200 &&
                     detected.radius > 200 && detected.radius < 900;

  return {
    valid: true,
    medallion: reasonable ? detected : defaults,
    detected: reasonable,
    raw: detected
  };
}

// ---------------------------------------------------------------------------
// Fast catalog loading via server-side cache
// ---------------------------------------------------------------------------
const CATALOG_ENDPOINT = 'cgi-bin/catalog.py';

// Load catalog instantly from server cache — no Drive API calls needed
async function loadCachedCatalog() {
  const resp = await fetch(CATALOG_ENDPOINT);
  if (!resp.ok) throw new Error(`Catalog cache error: ${resp.status}`);
  const catalog = await resp.json();
  if (catalog.error) throw new Error(catalog.error);

  // Store each book in the in-memory DB
  for (const book of catalog.books) {
    await window.DB.dbPut('books', book);
  }

  return catalog;
}

// Trigger a server-side refresh of the catalog cache
async function refreshCatalogCache() {
  const resp = await fetch(CATALOG_ENDPOINT + '/refresh', { method: 'POST' });
  if (!resp.ok) throw new Error(`Catalog refresh error: ${resp.status}`);
  const catalog = await resp.json();
  if (catalog.error) throw new Error(catalog.error);

  // Update in-memory DB
  for (const book of catalog.books) {
    await window.DB.dbPut('books', book);
  }

  return catalog;
}

// Check if cache is stale
async function catalogCacheStatus() {
  const resp = await fetch(CATALOG_ENDPOINT + '/status');
  if (!resp.ok) return { cached: false, stale: true };
  return await resp.json();
}

window.Drive = {
  listDriveSubfolders, listDriveFiles, getDriveDownloadUrl, getDriveThumbnailUrl,
  parseBookFolder, syncCatalog, downloadCoverAsImage, downloadCoverAsBlob,
  downloadCoverWithRetry,
  detectMedallionPosition, validateCoverTemplate,
  loadCachedCatalog, refreshCatalogCache, catalogCacheStatus
};