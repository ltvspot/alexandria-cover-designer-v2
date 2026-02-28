/**
 * iterate.js — Iterate page logic
 *
 * Responsibilities:
 *   - Load books from /api/books
 *   - Load models from /api/models
 *   - Handle Quick/Advanced mode toggle
 *   - POST /api/generate → queue jobs
 *   - Connect SSE per job_id → update progress + cards
 *   - Poll /api/analytics/budget for cost display
 *   - Show result cards with image thumbnails
 */

(function () {
  'use strict';

  // ─── State ────────────────────────────────────────────────────────────────
  let books = [];
  let models = [];
  let mode = 'quick';
  let activeJobs = new Map();      // job_id → {job, sseSource, startTime}
  let sessionCost = 0;
  let allResults = [];             // completed job results (persisted across reloads of UI)
  let selectedVariants = new Set([1, 2, 3]);

  // ─── DOM refs ─────────────────────────────────────────────────────────────
  const bookSelect      = el('book-select');
  const modelsContainer = el('models-container');
  const generateBtn     = el('generate-btn');
  const resultsGrid     = el('results-grid');
  const resultsCount    = el('results-count');
  const activeJobsPanel = el('active-jobs-panel');
  const activeJobsList  = el('active-jobs-list');
  const costToday       = el('cost-today');
  const costSession     = el('cost-session');
  const syncDot         = el('sync-dot');
  const syncText        = el('sync-text');
  const promptEditor    = el('prompt-editor');
  const promptSection   = el('prompt-section');
  const variantSection  = el('variant-section');
  const variantButtons  = qsa('.variant-btn');

  // ─── Init ─────────────────────────────────────────────────────────────────
  async function init() {
    setupModeToggle();
    setupVariantButtons();
    await Promise.all([loadBooks(), loadModels(), refreshCosts()]);
    setInterval(refreshCosts, 15000);
    // Restore any running jobs (poll DB)
    await restoreActiveJobs();
  }

  // ─── Mode toggle ──────────────────────────────────────────────────────────
  function setupModeToggle() {
    qsa('.mode-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        mode = btn.dataset.mode;
        qsa('.mode-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
        toggleAdvancedControls();
      });
    });
    toggleAdvancedControls();
  }

  function toggleAdvancedControls() {
    const adv = mode === 'advanced';
    promptSection && (promptSection.classList.toggle('hidden', !adv));
    variantSection && (variantSection.classList.toggle('hidden', !adv));
  }

  // ─── Variants ────────────────────────────────────────────────────────────
  function setupVariantButtons() {
    variantButtons.forEach(btn => {
      const v = parseInt(btn.dataset.variant, 10);
      btn.classList.toggle('selected', selectedVariants.has(v));
      btn.addEventListener('click', () => {
        if (selectedVariants.has(v)) {
          if (selectedVariants.size > 1) selectedVariants.delete(v);
        } else {
          selectedVariants.add(v);
        }
        btn.classList.toggle('selected', selectedVariants.has(v));
      });
    });
  }

  // ─── Books ────────────────────────────────────────────────────────────────
  async function loadBooks() {
    setSyncState('syncing', 'Loading books…');
    try {
      books = await API.get('/api/books');
      bookSelect.innerHTML = '';
      if (books.length === 0) {
        bookSelect.innerHTML = '<option value="">No books found — sync Drive first</option>';
        setSyncState('error', 'No books in catalog');
        return;
      }
      books.forEach(b => {
        const opt = document.createElement('option');
        opt.value = b.id;
        opt.textContent = b.number ? `${b.number}. ${b.title}` : b.title;
        if (b.author) opt.textContent += ` — ${b.author}`;
        bookSelect.appendChild(opt);
      });
      setSyncState('ok', `${books.length} books loaded`);
    } catch (e) {
      setSyncState('error', 'Drive unavailable');
      bookSelect.innerHTML = '<option value="">Drive unavailable</option>';
      console.error('loadBooks:', e);
    }
  }

  // ─── Models ───────────────────────────────────────────────────────────────
  async function loadModels() {
    try {
      models = await API.get('/api/models');
    } catch (e) {
      // Use defaults
      models = [
        { id: 'gemini-2.5-flash-image', label: 'Gemini 2.5 Flash Image', cost_per_image: 0.003, default: true },
        { id: 'gemini-2.0-flash-image', label: 'Gemini 2.0 Flash (Free)', cost_per_image: 0, default: false },
      ];
    }
    renderModels();
  }

  function renderModels() {
    if (!modelsContainer) return;
    modelsContainer.innerHTML = '';
    models.forEach((m, i) => {
      const checked = m.default || i < 1;
      const item = document.createElement('label');
      item.className = 'checkbox-item';
      item.innerHTML = `
        <input type="checkbox" name="model" value="${m.id}" ${checked ? 'checked' : ''}>
        <div class="model-info">
          <div class="model-name">${m.label}</div>
          <div class="model-cost">${m.cost_per_image > 0 ? formatCost(m.cost_per_image) + '/image' : 'Free'}</div>
        </div>
      `;
      modelsContainer.appendChild(item);
    });
  }

  // ─── Generate ─────────────────────────────────────────────────────────────
  generateBtn && generateBtn.addEventListener('click', handleGenerate);

  async function handleGenerate() {
    const bookId = bookSelect.value;
    if (!bookId) { toast('Please select a book', 'warn'); return; }

    const selectedModels = qsa('input[name="model"]:checked', modelsContainer).map(i => i.value);
    if (selectedModels.length === 0) { toast('Select at least one model', 'warn'); return; }

    const variants = mode === 'quick' ? [1] : Array.from(selectedVariants);
    const customPrompt = mode === 'advanced' && promptEditor ? promptEditor.value.trim() || null : null;

    generateBtn.disabled = true;
    generateBtn.textContent = 'Queuing…';

    try {
      const res = await API.post('/api/generate', {
        book_id: bookId,
        models: selectedModels,
        variants,
        prompt: customPrompt,
      });

      const { job_ids } = res;
      toast(`${job_ids.length} job(s) queued`, 'success', 3000);

      const book = books.find(b => b.id === bookId) || { title: 'Unknown', id: bookId };
      job_ids.forEach(jid => attachJob(jid, book));

    } catch (e) {
      toast('Failed to queue: ' + e.message, 'error');
    } finally {
      generateBtn.disabled = false;
      generateBtn.textContent = 'Generate';
    }
  }

  // ─── Job tracking ─────────────────────────────────────────────────────────

  function attachJob(jobId, book) {
    const startTime = Date.now();
    const cardId = `jcard-${jobId.substring(0, 8)}`;

    // Create in-progress card in results grid immediately
    const card = createInProgressCard(jobId, cardId, book, startTime);
    prependToGrid(card);

    // Add to active jobs panel
    renderActiveJobs();

    // Track
    activeJobs.set(jobId, { jobId, book, startTime, cardId, status: 'queued' });

    // Interval to update elapsed time on card
    const elapsedInterval = setInterval(() => {
      const eEl = document.getElementById(`elapsed-${cardId}`);
      if (eEl) eEl.textContent = formatElapsed(startTime);
    }, 1000);

    // SSE connection
    const sse = new EventSource(`/api/events/job/${jobId}`);
    let stallTimer = null;
    let isTerminal = false;

    const resetStall = () => {
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        if (!isTerminal) {
          toast('Generation is taking longer than usual…', 'warn', 6000);
          // Switch to polling
          startPolling(jobId, cardId, book, startTime, elapsedInterval);
          sse.close();
        }
      }, 35000);
    };

    resetStall();

    sse.onmessage = (e) => {
      const data = JSON.parse(e.data);
      resetStall();
      handleJobEvent(jobId, cardId, book, startTime, data, elapsedInterval);
      if (['completed', 'failed', 'cancelled'].includes(data.event)) {
        isTerminal = true;
        clearTimeout(stallTimer);
        clearInterval(elapsedInterval);
        sse.close();
        activeJobs.delete(jobId);
        renderActiveJobs();
      }
    };

    sse.onerror = () => {
      if (!isTerminal) {
        sse.close();
        startPolling(jobId, cardId, book, startTime, elapsedInterval);
      }
    };
  }

  function handleJobEvent(jobId, cardId, book, startTime, data, elapsedInterval) {
    const info = activeJobs.get(jobId);
    if (info) info.status = data.event;

    updateProgressCard(jobId, cardId, book, data, startTime);

    if (data.event === 'completed') {
      sessionCost += data.cost_usd || 0;
      updateCostDisplay();
      // Load full result card
      loadCompletedCard(jobId, cardId, book, data);
    } else if (data.event === 'failed') {
      markCardFailed(cardId, data.error);
    }
  }

  function startPolling(jobId, cardId, book, startTime, elapsedInterval) {
    const interval = setInterval(async () => {
      try {
        const job = await API.get(`/api/jobs/${jobId}`);
        handleJobEvent(jobId, cardId, book, startTime, { event: job.status, ...job }, elapsedInterval);
        if (['completed', 'failed', 'cancelled'].includes(job.status)) {
          clearInterval(interval);
          clearInterval(elapsedInterval);
          activeJobs.delete(jobId);
          renderActiveJobs();
        }
      } catch (e) {
        console.error('Polling error:', e);
      }
    }, 3000);
  }

  async function restoreActiveJobs() {
    try {
      const jobs = await API.get('/api/jobs?limit=20');
      jobs.filter(j => ['queued', 'running'].includes(j.status)).forEach(j => {
        const book = books.find(b => b.id === j.book_id) || { title: 'Unknown', id: j.book_id };
        attachJob(j.id, book);
      });
    } catch (e) {
      console.warn('Could not restore active jobs:', e);
    }
  }

  // ─── Cards ────────────────────────────────────────────────────────────────

  function createInProgressCard(jobId, cardId, book, startTime) {
    const card = document.createElement('div');
    card.className = 'result-card';
    card.id = cardId;
    card.innerHTML = `
      <div class="result-card-image">
        <div class="skeleton"></div>
      </div>
      <div class="result-card-body">
        <div class="result-card-meta">
          <span class="model-tag">Queued</span>
          <span class="variant-tag">${book.title}</span>
        </div>
        <div class="stage-indicator">
          <div class="stage-dot active" id="dot-${cardId}"></div>
          <span id="stage-${cardId}">Waiting in queue…</span>
        </div>
        <div class="elapsed-time mt-8" id="elapsed-${cardId}">0s</div>
        <div class="progress-bar-track mt-8">
          <div class="progress-bar-fill" id="prog-${cardId}" style="width: 5%"></div>
        </div>
      </div>
    `;
    return card;
  }

  const STAGE_PROGRESS = {
    starting: 10, downloading: 20, generating: 55, compositing: 80, scoring: 92,
  };

  function updateProgressCard(jobId, cardId, book, data, startTime) {
    const stageEl = document.getElementById(`stage-${cardId}`);
    const progEl  = document.getElementById(`prog-${cardId}`);
    const dotEl   = document.getElementById(`dot-${cardId}`);
    const metaEl  = qs('.model-tag', document.getElementById(cardId));

    if (data.event === 'progress') {
      const pct = STAGE_PROGRESS[data.stage] || 30;
      if (stageEl) stageEl.textContent = data.message || data.stage;
      if (progEl)  progEl.style.width = pct + '%';
      if (dotEl)   { dotEl.classList.remove('done'); dotEl.classList.add('active'); }
      if (metaEl)  metaEl.textContent = data.stage.charAt(0).toUpperCase() + data.stage.slice(1);
    }
    if (data.event === 'started') {
      if (stageEl) stageEl.textContent = 'Starting…';
      if (progEl)  progEl.style.width = '10%';
    }
    if (data.event === 'completed') {
      if (progEl) progEl.style.width = '100%';
      if (dotEl)  { dotEl.classList.remove('active'); dotEl.classList.add('done'); }
    }
  }

  function markCardFailed(cardId, error) {
    const card = document.getElementById(cardId);
    if (!card) return;
    const imgDiv = qs('.result-card-image', card);
    if (imgDiv) {
      imgDiv.innerHTML = `
        <div style="display:flex;align-items:center;justify-content:center;width:100%;height:100%;background:#fff0f0;color:#c94040;font-size:0.75rem;padding:16px;text-align:center;">
          Failed: ${error || 'Unknown error'}
        </div>
      `;
    }
    const stageEl = qs('.stage-indicator', card);
    if (stageEl) stageEl.innerHTML = `<span style="color:#c94040;font-size:0.75rem;">Failed</span>`;
    const prog = qs('.progress-bar-fill', card);
    if (prog) prog.style.background = '#c94040';
  }

  async function loadCompletedCard(jobId, cardId, book, eventData) {
    const card = document.getElementById(cardId);
    if (!card) return;

    let job;
    try {
      job = await API.get(`/api/jobs/${jobId}`);
    } catch (e) {
      job = { ...eventData, id: jobId, book_id: book.id };
    }

    const imgUrl = `/api/jobs/${jobId}/result-thumbnail?t=${Date.now()}`;
    const quality = job.quality_score ?? eventData.quality_score;
    const cost    = job.cost_usd ?? eventData.cost_usd ?? 0;

    card.innerHTML = `
      <div class="result-card-image">
        <img src="${imgUrl}" alt="Generated cover" loading="lazy"
             onerror="this.style.display='none'; this.parentElement.style.background='#eee'">
        ${quality != null ? `<span class="quality-badge">${formatScore(quality)}</span>` : ''}
      </div>
      <div class="result-card-body">
        <div class="result-card-meta">
          <span class="model-tag">${(job.model || '').replace('gemini-', 'G').replace('-image', '')}</span>
          <span class="variant-tag">Variant ${job.variant || 1}</span>
        </div>
        <div class="result-card-stats">
          <span>${formatCost(cost)}</span>
          <span>${job.duration_ms ? formatDuration(job.duration_ms) : ''}</span>
          <span>${book.title}</span>
        </div>
        <div class="result-card-actions mt-8">
          <button class="btn btn-sm btn-ghost" onclick="downloadJobResult('${jobId}', '${(book.title || '').replace(/'/g, '')}')">
            Download
          </button>
        </div>
      </div>
    `;

    allResults.unshift({ jobId, job, book });
    updateResultsCount();
  }

  function prependToGrid(card) {
    const emptyState = qs('.empty-state', resultsGrid);
    if (emptyState) emptyState.remove();
    resultsGrid.insertBefore(card, resultsGrid.firstChild);
    updateResultsCount();
  }

  function updateResultsCount() {
    if (resultsCount) {
      const n = resultsGrid.querySelectorAll('.result-card').length;
      resultsCount.textContent = n > 0 ? `${n} result${n !== 1 ? 's' : ''}` : '';
    }
  }

  // ─── Active jobs panel ────────────────────────────────────────────────────
  function renderActiveJobs() {
    if (!activeJobsList) return;
    if (activeJobs.size === 0) {
      hide(activeJobsPanel);
      return;
    }
    show(activeJobsPanel);
    activeJobsList.innerHTML = '';
    activeJobs.forEach(({ jobId, book, status }) => {
      const row = document.createElement('div');
      row.className = 'active-job-row';
      row.innerHTML = `
        <span class="job-book-title">${book.title}</span>
      `;
      row.appendChild(statusBadge(status));
      activeJobsList.appendChild(row);
    });
  }

  // ─── Costs ────────────────────────────────────────────────────────────────
  async function refreshCosts() {
    try {
      const [budget, costs] = await Promise.all([
        API.get('/api/analytics/budget'),
        API.get('/api/analytics/costs'),
      ]);
      if (costToday)   costToday.textContent = formatCost(budget.today_usd);
      if (costSession) costSession.textContent = formatCost(sessionCost);
    } catch (e) {
      // Silently ignore cost refresh failures
    }
  }

  function updateCostDisplay() {
    if (costSession) costSession.textContent = formatCost(sessionCost);
  }

  // ─── Sync status ──────────────────────────────────────────────────────────
  function setSyncState(state, text) {
    if (!syncDot || !syncText) return;
    syncDot.className = 'sync-dot' + (state === 'syncing' ? ' syncing' : state === 'error' ? ' error' : '');
    syncText.textContent = text;
  }

  // ─── Kick off ─────────────────────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', init);

})();
