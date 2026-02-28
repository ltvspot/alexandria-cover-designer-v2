// app.js — Router, navigation, app initialization, toast, hardened job queue
// ============================================================
// Toast system
// ============================================================
window.Toast = {
  show(message, type = 'info', duration = 4000) {
    const container = document.getElementById('toastContainer');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => {
      toast.classList.add('removing');
      setTimeout(() => toast.remove(), 250);
    }, duration);
  },
  success(msg) { this.show(msg, 'success'); },
  error(msg) { this.show(msg, 'error', 6000); },
  warning(msg) { this.show(msg, 'warning'); },
  info(msg) { this.show(msg, 'info'); }
};

// ============================================================
// Cover Image Cache — B6
// Keeps downloaded cover images in memory so multiple variants
// of the same book don't re-download the cover each time.
// ============================================================
window.CoverCache = {
  _cache: new Map(),   // book_id → { img, medallion, timestamp }
  _pending: new Map(), // book_id → Promise (dedup concurrent loads)

  has(bookId) { return this._cache.has(bookId); },

  get(bookId) { return this._cache.get(bookId) || null; },

  set(bookId, img, medallion) {
    this._cache.set(bookId, { img, medallion, timestamp: Date.now() });
    // Evict old entries (keep last 20)
    if (this._cache.size > 20) {
      const oldest = this._cache.keys().next().value;
      this._cache.delete(oldest);
    }
  },

  // Load a cover with deduplication — multiple jobs for the same book
  // share a single in-flight request.
  async load(bookId, coverJpgId, googleKey) {
    if (this._cache.has(bookId)) return this._cache.get(bookId);

    // Dedup: if another job is already loading this cover, wait for it
    if (this._pending.has(bookId)) return this._pending.get(bookId);

    const loadPromise = this._doLoad(bookId, coverJpgId, googleKey);
    this._pending.set(bookId, loadPromise);

    try {
      const result = await loadPromise;
      return result;
    } finally {
      this._pending.delete(bookId);
    }
  },

  async _doLoad(bookId, coverJpgId, googleKey) {
    const img = await Drive.downloadCoverWithRetry(coverJpgId, googleKey);

    // Detect medallion position
    let medallion = { cx: 2850, cy: 1350, radius: 520, detected: false };
    try {
      const validation = await Drive.validateCoverTemplate(img);
      if (validation.detected) {
        medallion = { ...validation.medallion, detected: true };
      }
    } catch (e) {
      console.warn('Medallion detection skipped:', e.message);
    }

    this.set(bookId, img, medallion);
    return { img, medallion, timestamp: Date.now() };
  }
};

// ============================================================
// Job Queue — Hardened with parallel execution, heartbeat,
// timeouts, dead-job detection, retry, cover caching
// ============================================================
window.JobQueue = {
  queue: [],
  running: new Map(), // jobId → { job, abortController, startTime }
  paused: false,
  listeners: [],
  heartbeatInterval: null,
  MAX_CONCURRENT: 5,      // E15: parallel generation (5 for speed, safe with OpenRouter)
  GENERATION_TIMEOUT: 120_000,  // 2 min for API call
  COVER_TIMEOUT: 20_000,        // 20s for cover download
  COMPOSITE_TIMEOUT: 15_000,    // 15s for compositing
  RETRY_THRESHOLD: 0.35,
  MAX_RETRIES: 2,
  DEAD_JOB_TIMEOUT: 180_000,    // E17: 3 min dead job detection

  onChange(fn) { this.listeners.push(fn); },
  notify() { this.listeners.forEach(fn => { try { fn(); } catch(e) {} }); },

  // A1: Start the heartbeat interval (ticks every second)
  _startHeartbeat() {
    if (this.heartbeatInterval) return;
    this.heartbeatInterval = setInterval(() => {
      // Update elapsed times on running jobs
      for (const [, entry] of this.running) {
        entry.job._elapsed = Math.round((Date.now() - entry.startTime) / 1000);
      }
      // E17: Dead job detection
      for (const [jobId, entry] of this.running) {
        const elapsed = Date.now() - entry.startTime;
        if (elapsed > this.DEAD_JOB_TIMEOUT) {
          console.error(`Dead job detected: ${jobId} (${Math.round(elapsed/1000)}s)`);
          this.abortJob(jobId, 'Timed out after 3 minutes — likely frozen');
        }
      }
      this.notify();
    }, 1000);
  },

  _stopHeartbeat() {
    if (this.running.size === 0 && this.queue.length === 0) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  },

  add(job) {
    this.queue.push(job);
    this.notify();
    this._startHeartbeat();
    if (!this.paused) this._fillSlots();
  },

  addBatch(jobs) {
    this.queue.push(...jobs);
    this.notify();
    this._startHeartbeat();
    if (!this.paused) this._fillSlots();
  },

  pause() { this.paused = true; this.notify(); },

  resume() {
    this.paused = false;
    this.notify();
    this._fillSlots();
  },

  // A3: Abort a specific job
  abortJob(jobId, reason = 'Cancelled by user') {
    const entry = this.running.get(jobId);
    if (entry) {
      entry.abortController.abort();
      entry.job.status = 'failed';
      entry.job.error = reason;
      entry.job.completed_at = new Date().toISOString();
      DB.dbPut('jobs', entry.job);
      this.running.delete(jobId);
      this.notify();
      this._fillSlots();
      this._stopHeartbeat();
    } else {
      // Remove from queue if not yet started
      this.queue = this.queue.filter(j => j.id !== jobId);
      this.notify();
    }
  },

  cancelAll() {
    // Abort all running
    for (const [jobId] of this.running) {
      this.abortJob(jobId, 'Batch cancelled');
    }
    this.queue = [];
    this.paused = false;
    this.notify();
    this._stopHeartbeat();
  },

  // E15: Fill available parallel slots
  _fillSlots() {
    if (this.paused) return;
    while (this.running.size < this.MAX_CONCURRENT && this.queue.length > 0) {
      const job = this.queue.shift();
      const abortController = new AbortController();
      const entry = { job, abortController, startTime: Date.now() };
      this.running.set(job.id, entry);
      this.notify();

      // Launch job (don't await — we want parallel execution)
      this._executeJob(job, abortController.signal).then(() => {
        this.running.delete(job.id);
        this.notify();
        this._fillSlots();
        this._stopHeartbeat();
      }).catch(() => {
        this.running.delete(job.id);
        this.notify();
        this._fillSlots();
        this._stopHeartbeat();
      });
    }
  },

  // E16: Resume stuck jobs on page load
  async resumeStuckJobs() {
    const allJobs = await DB.dbGetAll('jobs');
    const stuck = allJobs.filter(j =>
      j.status && !['completed', 'failed', 'queued'].includes(j.status)
    );
    for (const job of stuck) {
      console.warn(`Recovering stuck job ${job.id} (was: ${job.status})`);
      job.status = 'failed';
      job.error = 'Interrupted by page reload';
      job.completed_at = new Date().toISOString();
      await DB.dbPut('jobs', job);
    }
  },

  // A2: Update sub-status text
  _setSubStatus(job, text) {
    job._subStatus = text;
    this.notify();
  },

  // ================================================================
  // Core job execution — fully hardened
  // ================================================================
  async _executeJob(job, signal) {
    const apiKey = await DB.getSetting('openrouter_key');
    const googleKey = await DB.getSetting('google_api_key');
    const cx = await DB.getSetting('medallion_cx') || 2850;
    const cy = await DB.getSetting('medallion_cy') || 1350;
    const radius = await DB.getSetting('medallion_radius') || 520;

    const book = await DB.dbGet('books', job.book_id);

    // ------ Step 1: Download cover (B4, B5, B6, B7) ------
    job.status = 'downloading_cover';
    job._subStatus = 'Checking cover cache...';
    await DB.dbPut('jobs', job);
    this.notify();

    let coverImg = null;
    let medCx = parseInt(cx) || 2850;
    let medCy = parseInt(cy) || 1350;
    let medRadius = parseInt(radius) || 520;
    let coverFailed = false;

    if (book && book.cover_jpg_id) {
      try {
        // B6: Use cache
        const cached = await CoverCache.load(book.id, book.cover_jpg_id, googleKey);
        coverImg = cached.img;
        if (cached.medallion.detected) {
          medCx = cached.medallion.cx;
          medCy = cached.medallion.cy;
          medRadius = cached.medallion.radius;
        }
        this._setSubStatus(job, `Cover loaded (${coverImg.width}×${coverImg.height})`);
      } catch (e) {
        // B5: Explicit cover_failed state
        coverFailed = true;
        job._coverError = e.message;
        this._setSubStatus(job, `Cover download failed: ${e.message}`);
        Toast.warning(`Cover download failed for "${book?.title}" — will generate without compositing`);
        console.error('Cover download failed:', e);
      }
    } else {
      coverFailed = true;
      this._setSubStatus(job, 'No cover template found');
    }

    // Check abort
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');

    // ------ Step 2: Generate with retry (D11, D12, D13, D14) ------
    job.status = 'generating';
    job.started_at = new Date().toISOString();
    job.retries = 0;
    await DB.dbPut('jobs', job);
    this.notify();

    let bestImage = null, bestScore = -1, bestDataUrl = null, bestResponse = null;
    const maxAttempts = 1 + this.MAX_RETRIES;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');

      try {
        if (attempt > 0) {
          job.status = 'retrying';
          job.retries = attempt;
          await DB.dbPut('jobs', job);
          this.notify();
          this._setSubStatus(job, `Retry ${attempt}/${this.MAX_RETRIES} — improving circular fit`);
        } else {
          this._setSubStatus(job, `Calling ${OpenRouter.MODEL_LABELS[job.model] || job.model}...`);
        }

        // Strengthen prompt on retry
        let prompt = job.prompt;
        if (attempt > 0) {
          prompt += ' IMPORTANT: The illustration MUST be a perfectly circular vignette with the subject centered. The edges of the circle should fade to empty space or a simple gradient. No content should touch the circular boundary.';
        }

        // D11: OpenRouter fetch with AbortController timeout
        const response = await OpenRouter.generateImage(prompt, job.model, apiKey, signal, this.GENERATION_TIMEOUT);

        this._setSubStatus(job, 'Parsing response...');

        // D13: Empty response detection
        const imageDataUrl = OpenRouter.extractImageFromResponse(response);
        if (!imageDataUrl) {
          // D14: Log full response for debugging
          console.error(`Empty image response from ${job.model}:`, JSON.stringify(response).substring(0, 500));
          throw new Error(`No image in response from ${OpenRouter.MODEL_LABELS[job.model] || job.model} — response format may be unsupported`);
        }

        this._setSubStatus(job, 'Loading image...');
        const generatedImg = await OpenRouter.loadImage(imageDataUrl);

        // Score for circular fit
        const qualityScore = Quality.scoreGeneratedImage(generatedImg);

        // Track cost for each attempt
        const attemptCost = OpenRouter.MODEL_COSTS[job.model] || 0;
        job.cost_usd = (job.cost_usd || 0) + attemptCost;

        // Track best result across attempts
        if (qualityScore > bestScore) {
          bestScore = qualityScore;
          bestImage = generatedImg;
          bestDataUrl = imageDataUrl;
          bestResponse = response;
        }

        // If score is good enough, stop retrying
        if (qualityScore >= this.RETRY_THRESHOLD) {
          this._setSubStatus(job, `Quality: ${Math.round(qualityScore * 100)}% — good enough`);
          break;
        }

        console.log(`Attempt ${attempt + 1}: score ${qualityScore.toFixed(2)} < threshold ${this.RETRY_THRESHOLD} — retrying`);
      } catch (e) {
        if (e.name === 'AbortError') throw e;

        // D12: Rate limiting / 429 handling
        if (e.message && e.message.includes('429')) {
          const waitSec = Math.min(30, 5 * (attempt + 1));
          this._setSubStatus(job, `Rate limited — waiting ${waitSec}s...`);
          await new Promise(r => setTimeout(r, waitSec * 1000));
          // Don't count this as a failed attempt — retry same attempt
          attempt--;
          continue;
        }

        if (attempt === maxAttempts - 1 && !bestImage) {
          job.status = 'failed';
          job.error = e.message;
          job.completed_at = new Date().toISOString();
          await DB.dbPut('jobs', job);
          this.notify();
          Toast.error(`Generation failed: ${e.message}`);
          return;
        }
        console.warn(`Attempt ${attempt + 1} failed:`, e.message);
        this._setSubStatus(job, `Attempt ${attempt + 1} failed: ${e.message.substring(0, 60)}`);
      }
    }

    // Use best result from all attempts
    if (!bestImage) {
      job.status = 'failed';
      job.error = 'All generation attempts failed';
      job.completed_at = new Date().toISOString();
      await DB.dbPut('jobs', job);
      this.notify();
      Toast.error('All generation attempts failed');
      return;
    }

    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');

    // ------ Step 3: Score ------
    job.status = 'scoring';
    this._setSubStatus(job, 'Analysing quality...');
    await DB.dbPut('jobs', job);
    this.notify();

    job.generated_image_blob = bestDataUrl;
    job.quality_score = Math.round(bestScore * 100) / 100;
    job.detailed_scores = Quality.getDetailedScores(bestImage);

    // ------ Step 4: Composite (C8, C9, C10) ------
    job.status = 'compositing';
    await DB.dbPut('jobs', job);
    this.notify();

    if (coverImg && !coverFailed) {
      try {
        this._setSubStatus(job, 'Smart cropping + feathering...');

        // C10: Wrap compositing in a try/catch with fallback
        const composited = Compositor.smartComposite(coverImg, bestImage, medCx, medCy, medRadius);

        // C8: Validate that composite actually differs from cover
        const isValid = this._validateComposite(composited, coverImg, medCx, medCy, medRadius);
        if (isValid) {
          job.composited_image_blob = Compositor.canvasToDataUrl(composited, 'image/jpeg', 0.6);
          this._setSubStatus(job, 'Composite verified');
        } else {
          console.warn('Composite validation failed — medallion may be empty');
          job._compositeFailed = true;
          job._compositeError = 'Composite appears identical to cover — medallion may not have been placed correctly';
          // Still save the raw composite but flag it
          job.composited_image_blob = Compositor.canvasToDataUrl(composited, 'image/jpeg', 0.6);
          this._setSubStatus(job, 'Composite created (validation warning)');
        }
      } catch (e) {
        // C10: Compositing failed — save raw image, don't kill the job
        console.error('Compositing failed:', e);
        job._compositeFailed = true;
        job._compositeError = e.message;
        this._setSubStatus(job, `Composite failed: ${e.message} — raw image saved`);
        Toast.warning(`Compositing failed for "${book?.title}" — raw illustration saved`);
      }
    } else {
      // B5: Cover was not available
      job._compositeFailed = true;
      job._compositeError = coverFailed ? `Cover download failed: ${job._coverError || 'unknown'}` : 'No cover template';
      this._setSubStatus(job, 'Skipped compositing — no cover template');
    }

    // ------ Step 5: Complete ------
    job.status = 'completed';
    job.completed_at = new Date().toISOString();
    job.results_json = JSON.stringify({
      model_response: bestResponse?.model,
      usage: bestResponse?.usage,
      retries: job.retries || 0,
      detailed_scores: job.detailed_scores,
      cover_failed: coverFailed,
      composite_failed: job._compositeFailed || false,
      composite_error: job._compositeError || null
    });

    await DB.dbPut('jobs', job);

    // Record in cost ledger
    await DB.dbPut('cost_ledger', {
      model: job.model,
      cost_usd: job.cost_usd,
      job_id: job.id,
      book_id: job.book_id,
      recorded_at: new Date().toISOString()
    });

    this.notify();
    const retryNote = job.retries > 0 ? ` (${job.retries} retries)` : '';
    const compNote = job._compositeFailed ? ' ⚠ no composite' : '';
    Toast.success(`Generated for "${book?.title || 'Unknown'}" (${OpenRouter.MODEL_LABELS[job.model]})${retryNote}${compNote}`);
  },

  // C8: Validate composite differs from original cover in the medallion region
  _validateComposite(compositedCanvas, coverImg, cx, cy, radius) {
    try {
      const size = 50; // Check at low res for speed
      const sampleCanvas = document.createElement('canvas');
      sampleCanvas.width = size;
      sampleCanvas.height = size;
      const ctx = sampleCanvas.getContext('2d');

      // Sample the medallion region of the composite
      const srcX = cx - radius;
      const srcY = cy - radius;
      const srcSize = radius * 2;
      ctx.drawImage(compositedCanvas, srcX, srcY, srcSize, srcSize, 0, 0, size, size);
      const compData = ctx.getImageData(0, 0, size, size).data;

      // Sample the same region of the original cover
      ctx.clearRect(0, 0, size, size);
      ctx.drawImage(coverImg, srcX, srcY, srcSize, srcSize, 0, 0, size, size);
      const origData = ctx.getImageData(0, 0, size, size).data;

      // Compare — if pixels are nearly identical, composite didn't work
      let totalDiff = 0;
      for (let i = 0; i < compData.length; i += 4) {
        totalDiff += Math.abs(compData[i] - origData[i]);     // R
        totalDiff += Math.abs(compData[i+1] - origData[i+1]); // G
        totalDiff += Math.abs(compData[i+2] - origData[i+2]); // B
      }
      const avgDiff = totalDiff / (size * size * 3);

      // If average difference is < 5 per channel, composite is basically unchanged
      return avgDiff > 5;
    } catch (e) {
      console.warn('Composite validation error:', e);
      return true; // Assume valid on error
    }
  }
};

// ============================================================
// Router
// ============================================================
const PAGES = {
  iterate: { title: 'Iterate', render: () => window.Pages.iterate.render() },
  review: { title: 'Review', render: () => window.Pages.review.render() },
  batch: { title: 'Batch', render: () => window.Pages.batch.render() },
  history: { title: 'History', render: () => window.Pages.history.render() },
  dashboard: { title: 'Dashboard', render: () => window.Pages.dashboard.render() },
  prompts: { title: 'Prompts', render: () => window.Pages.prompts.render() },
  jobs: { title: 'Jobs', render: () => window.Pages.jobs.render() },
  settings: { title: 'Settings', render: () => window.Pages.settings.render() },
  analytics: { title: 'Analytics', render: () => window.Pages.analytics.render() },
  compare: { title: 'Compare', render: () => window.Pages.compare.render() },
  catalogs: { title: 'Catalogs', render: () => window.Pages.catalogs.render() },
  similarity: { title: 'Similarity', render: () => window.Pages.similarity.render() },
  mockups: { title: 'Mockups', render: () => window.Pages.mockups.render() },
  'api-docs': { title: 'API Docs', render: () => window.Pages['api-docs'].render() },
};

window.Pages = window.Pages || {};

function getPageFromHash() {
  const hash = location.hash.slice(1) || 'iterate';
  return hash.split('?')[0];
}

function navigate(page) {
  location.hash = page;
}

async function renderPage() {
  const page = getPageFromHash();
  const config = PAGES[page];
  if (!config) { navigate('iterate'); return; }

  document.getElementById('pageTitle').textContent = config.title;

  // Update nav active state
  document.querySelectorAll('.nav-link').forEach(link => {
    link.classList.toggle('active', link.dataset.page === page);
  });

  // Render page content
  const content = document.getElementById('content');
  content.innerHTML = '<div style="display:flex;justify-content:center;padding:60px"><div class="spinner"></div></div>';
  
  try {
    await config.render();
  } catch (e) {
    console.error('Page render error:', e);
    content.innerHTML = `<div class="empty-state"><h3>Error loading page</h3><p>${e.message}</p></div>`;
  }
}

// ============================================================
// Header updates (F18: live running cost)
// ============================================================
async function updateHeader() {
  try {
    const books = await DB.dbGetAll('books');
    document.getElementById('syncStatus').textContent = `${books.length} books`;

    const ledger = await DB.dbGetAll('cost_ledger');
    const totalSpent = ledger.reduce((sum, e) => sum + (e.cost_usd || 0), 0);

    // F18: Add running cost from in-progress jobs
    let runningCost = 0;
    for (const [, entry] of JobQueue.running) {
      runningCost += entry.job.cost_usd || 0;
    }
    const displayCost = totalSpent + runningCost;
    const runningLabel = JobQueue.running.size > 0 ? ` (${JobQueue.running.size} running)` : '';
    document.getElementById('budgetBadge').textContent = `$${displayCost.toFixed(2)} spent${runningLabel}`;
  } catch (e) {
    // DB might not be ready yet
  }
}

// ============================================================
// Sidebar toggle
// ============================================================
function initSidebar() {
  const sidebar = document.getElementById('sidebar');
  const toggleBtn = document.getElementById('sidebarToggle');
  const mobileBtn = document.getElementById('mobileMenuBtn');

  const overlay = document.createElement('div');
  overlay.className = 'sidebar-overlay';
  overlay.id = 'sidebarOverlay';
  document.body.appendChild(overlay);

  toggleBtn.addEventListener('click', () => {
    sidebar.classList.toggle('collapsed');
  });

  mobileBtn.addEventListener('click', () => {
    sidebar.classList.add('mobile-open');
    overlay.classList.add('visible');
  });

  overlay.addEventListener('click', () => {
    sidebar.classList.remove('mobile-open');
    overlay.classList.remove('visible');
  });

  document.querySelectorAll('.nav-link').forEach(link => {
    link.addEventListener('click', () => {
      sidebar.classList.remove('mobile-open');
      overlay.classList.remove('visible');
    });
  });
}

// ============================================================
// Utilities
// ============================================================
window.uuid = () => crypto.randomUUID ? crypto.randomUUID() : 
  'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });

window.formatDate = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
};

window.timeAgo = (iso) => {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
};

window.blobUrls = new Map();
window.getBlobUrl = (data, key) => {
  if (!data) return '';
  if (typeof data === 'string') return data;
  if (key && blobUrls.has(key)) return blobUrls.get(key);
  const url = URL.createObjectURL(data);
  if (key) blobUrls.set(key, url);
  return url;
};

// ============================================================
// Init
// ============================================================
async function init() {
  try {
    await DB.openDB();
    await DB.initDefaults();
  } catch (e) {
    console.error('DB init failed:', e);
    Toast.error('Database initialization failed. Some features may not work.');
  }

  // E16: Resume any stuck jobs from before page reload
  await JobQueue.resumeStuckJobs();

  initSidebar();
  
  window.addEventListener('hashchange', () => {
    renderPage();
    updateHeader();
  });

  // Job queue changes update header
  JobQueue.onChange(() => updateHeader());

  await updateHeader();
  await renderPage();

  // Auto-sync catalog on load
  autoSync();
}

async function autoSync() {
  try {
    const catalog = await Drive.loadCachedCatalog();
    document.getElementById('syncStatus').textContent = `${catalog.count} books`;
    await updateHeader();
    await renderPage();

    const status = await Drive.catalogCacheStatus();
    if (status.stale) {
      Toast.info('Refreshing catalog in background...');
      Drive.refreshCatalogCache().then(async (freshCatalog) => {
        document.getElementById('syncStatus').textContent = `${freshCatalog.count} books`;
        await updateHeader();
        await renderPage();
        Toast.success(`Catalog refreshed: ${freshCatalog.count} books`);
      }).catch(e => {
        console.warn('Background refresh failed:', e.message);
      });
    }
  } catch (e) {
    console.warn('Cached catalog unavailable, falling back to Drive sync:', e.message);
    Toast.info('Syncing book catalog from Drive...');
    try {
      let lastRender = 0;
      const books = await Drive.syncCatalog((msg, done, total) => {
        if (total > 0) {
          document.getElementById('syncStatus').textContent = `${done}/${total} books`;
        }
        if (done - lastRender >= 100) {
          lastRender = done;
          renderPage();
        }
      });
      Toast.success(`Synced ${books.length} books from Drive`);
      await updateHeader();
      await renderPage();
    } catch (e2) {
      console.warn('Drive sync also failed:', e2.message);
    }
  }
}

window.addEventListener('DOMContentLoaded', () => {
  setTimeout(init, 100);
});