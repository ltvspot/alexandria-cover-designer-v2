// app.js — Server-side UI adapter for iterate workflow
(function () {
  'use strict';

  const API = {
    async get(path) {
      const r = await fetch(path);
      if (!r.ok) throw new Error(`GET ${path} failed: ${r.status}`);
      return r.json();
    },
    async post(path, body) {
      const r = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const text = await r.text();
        throw new Error(`POST ${path} failed: ${r.status} ${text}`);
      }
      return r.json();
    },
  };

  // ============================================================
  // Toast system
  // ============================================================
  window.Toast = {
    show(message, type = 'info', duration = 4000) {
      const container = document.getElementById('toastContainer');
      if (!container) return;
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

  const state = {
    books: [],
    models: [],
    prompts: [],
    modeAdvanced: true,
    jobs: new Map(),
    eventSources: new Map(),
    activeTimers: new Map(),
    renderTimer: null,
  };

  const STAGES = ['queued', 'cover', 'generating', 'retrying', 'scoring', 'compositing', 'done'];
  const STAGE_LABELS = {
    queued: 'Queued',
    cover: 'Cover',
    generating: 'Generating',
    retrying: 'Retrying',
    scoring: 'Scoring',
    compositing: 'Compositing',
    done: 'Done',
  };

  const STAGE_INDEX = {
    queued: 0,
    starting: 0,
    cover: 1,
    downloading: 1,
    generating: 2,
    retrying: 3,
    scoring: 4,
    compositing: 5,
    done: 6,
    completed: 6,
    failed: 6,
    cancelled: 6,
  };

  function byId(id) {
    return document.getElementById(id);
  }

  function fmtUsd(v) {
    const n = Number(v || 0);
    return `$${n.toFixed(3)}`;
  }

  function fmtPct(v) {
    const n = Number(v || 0);
    return `${Math.round(n * 100)}%`;
  }

  function qualityClass(score) {
    if (score >= 0.7) return 'high';
    if (score >= 0.45) return 'medium';
    return 'low';
  }

  function elapsedSeconds(startedAtMs) {
    return Math.max(0, Math.floor((Date.now() - startedAtMs) / 1000));
  }

  function initShell() {
    const sidebar = byId('sidebar');
    const sidebarToggle = byId('sidebarToggle');
    const mobileMenuBtn = byId('mobileMenuBtn');

    if (sidebarToggle && sidebar) {
      sidebarToggle.addEventListener('click', () => {
        sidebar.classList.toggle('collapsed');
      });
    }

    if (mobileMenuBtn && sidebar) {
      mobileMenuBtn.addEventListener('click', () => {
        sidebar.classList.toggle('open');
      });
    }
  }

  async function updateHeader() {
    try {
      const [budget, books] = await Promise.all([
        API.get('/api/analytics/budget'),
        API.get('/api/books'),
      ]);

      const spent = Number(budget.today_usd || 0);
      const budgetBadge = byId('budgetBadge');
      const syncStatus = byId('syncStatus');

      if (budgetBadge) budgetBadge.textContent = `$${spent.toFixed(2)} spent`;
      if (syncStatus) syncStatus.textContent = `${books.length} books`;
    } catch (err) {
      console.error('Header update failed:', err);
    }
  }

  function renderIteratePage() {
    const content = byId('content');
    const pageTitle = byId('pageTitle');
    if (pageTitle) pageTitle.textContent = 'Iterate';

    content.innerHTML = `
      <div class="card">
        <div class="card-header">
          <span class="card-title">Generate Illustrations</span>
          <div class="toggle-wrap">
            <span class="text-sm text-muted">Quick</span>
            <div class="toggle on" id="modeToggle"></div>
            <span class="text-sm text-muted">Advanced</span>
          </div>
        </div>

        <div class="form-row mb-16">
          <div class="form-group" style="flex:1">
            <label class="form-label">Book</label>
            <select class="form-select" id="bookSelect">
              <option value="">Loading books…</option>
            </select>
            <span class="form-hint" id="bookHint">0 books loaded</span>
          </div>
          <div class="form-group" style="flex:0 0 auto">
            <label class="form-label">&nbsp;</label>
            <button class="btn btn-secondary btn-sm" id="syncBtn">Sync</button>
          </div>
        </div>

        <div class="form-group">
          <label class="form-label">Models <span class="text-xs text-muted">(best → budget, top → bottom)</span></label>
          <div class="checkbox-group" id="modelCheckboxes"></div>
        </div>

        <div id="advancedOptions" style="display:block">
          <div class="form-row mb-16">
            <div class="form-group">
              <label class="form-label">Variants per model</label>
              <select class="form-select" id="variantCount">
                ${[1,2,3,4,5,6,7,8,9,10].map(n => `<option value="${n}" ${n === 1 ? 'selected' : ''}>${n}</option>`).join('')}
              </select>
            </div>
            <div class="form-group">
              <label class="form-label">Prompt template</label>
              <select class="form-select" id="promptTemplate">
                <option value="">— Default prompt —</option>
              </select>
            </div>
          </div>
          <div class="form-group">
            <label class="form-label">Custom prompt</label>
            <textarea class="form-textarea" id="customPrompt" rows="3" placeholder="Override the prompt. Use {title} and {author} placeholders..."></textarea>
          </div>
        </div>

        <div style="display:flex;gap:8px;margin-top:16px;align-items:center">
          <button class="btn btn-primary" id="generateBtn">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>
            Generate
          </button>
          <button class="btn btn-danger btn-sm" id="cancelAllBtn" style="display:none">Cancel All</button>
          <span class="text-sm text-muted" id="costEstimate" style="line-height:36px"></span>
        </div>
      </div>

      <div id="pipelineArea" style="display:none" class="card">
        <div class="card-header" style="margin-bottom:12px">
          <span class="card-title">Generation Progress</span>
          <span class="text-sm text-muted" id="pipelineSummary"></span>
        </div>
        <div id="pipelineSteps"></div>
      </div>

      <div id="resultsArea">
        <div class="card-header" style="margin-bottom:12px">
          <span class="card-title">Results</span>
        </div>
        <div class="grid-auto" id="resultsGrid"></div>
      </div>
    `;

    bindIterateEvents();
  }

  async function loadBooks() {
    const select = byId('bookSelect');
    const hint = byId('bookHint');
    const syncStatus = byId('syncStatus');

    state.books = await API.get('/api/books');
    state.books.sort((a, b) => {
      const na = Number(a.number || 999999);
      const nb = Number(b.number || 999999);
      if (na !== nb) return na - nb;
      return String(a.title || '').localeCompare(String(b.title || ''));
    });

    select.innerHTML = '<option value="">— Select a book —</option>';
    state.books.forEach((book) => {
      const opt = document.createElement('option');
      opt.value = book.id;
      const number = book.number ? `${book.number} — ` : '';
      const author = book.author ? ` - ${book.author}` : '';
      opt.textContent = `${number}${book.title}${author}`;
      select.appendChild(opt);
    });

    if (hint) hint.textContent = `${state.books.length} books loaded`;
    if (syncStatus) syncStatus.textContent = `${state.books.length} books`;
  }

  async function loadPrompts() {
    state.prompts = await API.get('/api/prompts');
    const sel = byId('promptTemplate');
    if (!sel) return;
    sel.innerHTML = '<option value="">— Default prompt —</option>';
    state.prompts.forEach((p) => {
      const opt = document.createElement('option');
      opt.value = String(p.id);
      opt.textContent = p.name;
      sel.appendChild(opt);
    });
  }

  async function loadModels() {
    state.models = await API.get('/api/models');

    const box = byId('modelCheckboxes');
    box.innerHTML = '';

    state.models.forEach((m, i) => {
      const item = document.createElement('div');
      item.className = 'checkbox-item';
      item.innerHTML = `
        <input type="checkbox" id="m_${m.id}" value="${m.id}" ${i < 3 ? 'checked' : ''}>
        <label for="m_${m.id}">${m.label} ($${Number(m.cost_per_image || 0).toFixed(3)})</label>
      `;
      box.appendChild(item);
    });

    updateCostEstimate();
  }

  function bindIterateEvents() {
    const modeToggle = byId('modeToggle');
    const advancedOptions = byId('advancedOptions');
    const variantCount = byId('variantCount');
    const modelBox = byId('modelCheckboxes');
    const promptTemplate = byId('promptTemplate');
    const customPrompt = byId('customPrompt');
    const syncBtn = byId('syncBtn');

    state.modeAdvanced = true;

    modeToggle.addEventListener('click', function () {
      this.classList.toggle('on');
      state.modeAdvanced = this.classList.contains('on');
      advancedOptions.style.display = state.modeAdvanced ? 'block' : 'none';
      updateCostEstimate();
    });

    modelBox.addEventListener('change', updateCostEstimate);
    variantCount.addEventListener('change', updateCostEstimate);

    promptTemplate.addEventListener('change', () => {
      const id = Number(promptTemplate.value);
      const p = state.prompts.find((x) => Number(x.id) === id);
      if (p && p.template) customPrompt.value = p.template;
    });

    byId('generateBtn').addEventListener('click', handleGenerate);
    byId('cancelAllBtn').addEventListener('click', cancelAllActive);

    syncBtn.addEventListener('click', async () => {
      syncBtn.disabled = true;
      syncBtn.textContent = 'Syncing...';
      try {
        const res = await API.post('/api/catalogs/sync', {});
        window.Toast.success(`Catalog synced (${res.count || 0} books)`);
      } catch (err) {
        window.Toast.error(`Sync failed: ${err.message}`);
      } finally {
        syncBtn.disabled = false;
        syncBtn.textContent = 'Sync';
        await loadBooks();
      }
    });
  }

  function selectedModels() {
    return Array.from(document.querySelectorAll('#modelCheckboxes input:checked')).map((el) => el.value);
  }

  function updateCostEstimate() {
    const models = selectedModels();
    const variants = state.modeAdvanced ? Number(byId('variantCount').value || 1) : 1;
    const byIdModel = new Map(state.models.map((m) => [m.id, m]));
    const perPass = models.reduce((sum, id) => sum + Number((byIdModel.get(id) || {}).cost_per_image || 0), 0);
    const total = perPass * variants;
    const costEstimate = byId('costEstimate');
    costEstimate.textContent = models.length ? `Est. cost: $${total.toFixed(3)}` : '';
  }

  function resolvePromptForBook(book) {
    const custom = (byId('customPrompt').value || '').trim();
    if (!custom) return null;
    return custom
      .replaceAll('{title}', book.title || '')
      .replaceAll('{author}', book.author || '');
  }

  async function handleGenerate() {
    const bookId = byId('bookSelect').value;
    if (!bookId) {
      window.Toast.warning('Select a book first');
      return;
    }

    const models = selectedModels();
    if (!models.length) {
      window.Toast.warning('Select at least one model');
      return;
    }

    const book = state.books.find((b) => b.id === bookId) || { id: bookId, title: 'Unknown', author: '' };
    const variantsCount = state.modeAdvanced ? Number(byId('variantCount').value || 1) : 1;
    const variants = Array.from({ length: variantsCount }, (_, i) => i + 1);
    const prompt = resolvePromptForBook(book);

    const generateBtn = byId('generateBtn');
    generateBtn.disabled = true;

    try {
      const planned = [];
      models.forEach((m) => variants.forEach((v) => planned.push({ model: m, variant: v })));

      const res = await API.post('/api/generate', {
        book_id: bookId,
        models,
        variants,
        prompt,
      });

      const jobIds = res.job_ids || [];
      if (!jobIds.length) {
        window.Toast.warning('No jobs were queued');
        return;
      }

      jobIds.forEach((jobId, idx) => {
        const meta = planned[idx] || { model: models[0], variant: 1 };
        const modelCfg = state.models.find((m) => m.id === meta.model) || { label: meta.model, cost_per_image: 0 };

        state.jobs.set(jobId, {
          id: jobId,
          book,
          model: meta.model,
          modelLabel: modelCfg.label,
          variant: meta.variant,
          styleLabel: null,
          status: 'queued',
          stage: 'queued',
          message: 'Queued',
          startedAtMs: Date.now(),
          completedAtMs: null,
          costUsd: 0,
          qualityScore: null,
          compositeVerified: false,
        });

        attachJobEvents(jobId);
      });

      byId('pipelineArea').style.display = 'block';
      byId('cancelAllBtn').style.display = 'inline-flex';
      window.Toast.success(`Queued ${jobIds.length} job(s)`);
      renderAll();
    } catch (err) {
      window.Toast.error(`Generate failed: ${err.message}`);
    } finally {
      generateBtn.disabled = false;
    }
  }

  function attachJobEvents(jobId) {
    const source = new EventSource(`/api/events/job/${jobId}`);
    state.eventSources.set(jobId, source);

    source.onmessage = async (ev) => {
      let data;
      try {
        data = JSON.parse(ev.data);
      } catch {
        return;
      }
      handleJobEvent(jobId, data);

      if (['completed', 'failed', 'cancelled'].includes(data.event)) {
        source.close();
        state.eventSources.delete(jobId);

        // Load full job details after completion for style/cost/result metadata
        try {
          const full = await API.get(`/api/jobs/${jobId}`);
          hydrateJobFromApi(jobId, full);
        } catch (err) {
          console.warn('Failed to fetch completed job detail:', err);
        }

        renderAll();
      }
    };

    source.onerror = async () => {
      source.close();
      state.eventSources.delete(jobId);
      // fallback poll once for status
      try {
        const full = await API.get(`/api/jobs/${jobId}`);
        hydrateJobFromApi(jobId, full);
      } catch {
        // ignore
      }
      renderAll();
    };
  }

  function handleJobEvent(jobId, event) {
    const job = state.jobs.get(jobId);
    if (!job) return;

    if (event.event === 'started') {
      job.status = 'running';
      job.stage = 'cover';
      job.message = 'Starting';
      if (!job.startedAtMs) job.startedAtMs = Date.now();
    } else if (event.event === 'progress') {
      job.status = 'running';
      if (event.stage) job.stage = event.stage;
      if (event.message) job.message = event.message;
      if (event.stage === 'compositing' && String(event.message || '').toLowerCase().includes('verified')) {
        job.compositeVerified = true;
      }
    } else if (event.event === 'heartbeat') {
      // no-op, elapsed is derived from start time
    } else if (event.event === 'completed') {
      job.status = 'completed';
      job.stage = 'done';
      job.completedAtMs = Date.now();
      if (typeof event.cost_usd === 'number') job.costUsd = event.cost_usd;
      if (typeof event.quality_score === 'number') job.qualityScore = event.quality_score;
      if (event.style_label) job.styleLabel = event.style_label;
    } else if (event.event === 'failed') {
      job.status = 'failed';
      job.stage = 'done';
      job.message = event.error || 'Failed';
      job.completedAtMs = Date.now();
    } else if (event.event === 'cancelled') {
      job.status = 'cancelled';
      job.stage = 'done';
      job.completedAtMs = Date.now();
    }

    renderAll();
  }

  function hydrateJobFromApi(jobId, full) {
    const job = state.jobs.get(jobId);
    if (!job) return;

    job.status = full.status || job.status;
    job.model = full.model || job.model;
    const modelCfg = state.models.find((m) => m.id === job.model);
    if (modelCfg) job.modelLabel = modelCfg.label;
    job.variant = full.variant || job.variant;
    job.costUsd = Number(full.cost_usd || job.costUsd || 0);
    job.qualityScore = typeof full.quality_score === 'number' ? full.quality_score : job.qualityScore;

    if (full.results_json) {
      try {
        const parsed = JSON.parse(full.results_json);
        if (parsed.style_label) job.styleLabel = parsed.style_label;
        if (parsed.composite_verified) job.compositeVerified = true;
      } catch {
        // ignore parse errors
      }
    }
  }

  function renderAll() {
    renderPipeline();
    renderResults();
    updatePipelineSummary();
  }

  function stageClassFor(job, stage, stageIdx) {
    const current = STAGE_INDEX[job.stage] ?? 0;
    if (job.status === 'failed') {
      return stageIdx <= current ? 'pipeline-step error' : 'pipeline-step';
    }
    if (stageIdx < current) return 'pipeline-step done';
    if (stageIdx === current && !['completed', 'failed', 'cancelled'].includes(job.status)) return 'pipeline-step active';
    if (stage === 'done' && job.status === 'completed') return 'pipeline-step done';
    return 'pipeline-step';
  }

  function statusTag(job) {
    if (job.status === 'completed') return '<span class="tag tag-status">Done</span>';
    if (job.status === 'failed') return '<span class="tag tag-failed">Failed</span>';
    if (job.status === 'queued') return '<span class="tag tag-queued">Queued</span>';
    return '<span class="tag tag-pending">Active</span>';
  }

  function renderPipeline() {
    const pipeline = byId('pipelineSteps');
    if (!pipeline) return;

    const jobs = Array.from(state.jobs.values());
    if (!jobs.length) {
      pipeline.innerHTML = '<div class="text-muted">No active jobs</div>';
      return;
    }

    pipeline.innerHTML = jobs.map((job) => {
      const elapsed = ['completed', 'failed', 'cancelled'].includes(job.status)
        ? Math.max(0, Math.floor(((job.completedAtMs || Date.now()) - (job.startedAtMs || Date.now())) / 1000))
        : elapsedSeconds(job.startedAtMs || Date.now());

      const steps = STAGES.map((s, idx) => {
        const cls = stageClassFor(job, s, idx);
        const arrow = idx < STAGES.length - 1 ? '<span class="pipeline-arrow">→</span>' : '';
        return `<span class="${cls}">${STAGE_LABELS[s]}</span>${arrow}`;
      }).join('');

      const styleTag = job.styleLabel ? `<span class="tag tag-style">${job.styleLabel}</span>` : '';
      const heartbeat = ['running', 'queued'].includes(job.status)
        ? `<span class="heartbeat-pulse"></span><span class="text-xs" style="color:#16a34a;font-weight:600">${elapsed}s</span>`
        : '';
      const verified = job.compositeVerified ? '<div class="text-xs text-muted" style="margin-top:2px">Composite verified</div>' : '';

      return `
        <div class="pipeline-row" style="margin-bottom:6px;padding:6px 0;border-bottom:1px solid #f1f5f9">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;flex-wrap:wrap">
            <span class="tag tag-model">${job.modelLabel || job.model}</span>
            ${styleTag}
            <span class="text-xs text-muted">v${job.variant || 1}</span>
            ${statusTag(job)}
            ${heartbeat}
            ${job.costUsd ? `<span class="text-xs text-muted">${fmtUsd(job.costUsd)}</span>` : ''}
          </div>
          <div class="pipeline">${steps}</div>
          <div class="text-xs text-muted" style="margin-top:2px">${job.message || ''}</div>
          ${verified}
        </div>
      `;
    }).join('');

    const hasActive = jobs.some((j) => ['queued', 'running'].includes(j.status));
    byId('cancelAllBtn').style.display = hasActive ? 'inline-flex' : 'none';
    byId('pipelineArea').style.display = jobs.length ? 'block' : 'none';
  }

  function updatePipelineSummary() {
    const el = byId('pipelineSummary');
    if (!el) return;
    const jobs = Array.from(state.jobs.values());
    if (!jobs.length) {
      el.textContent = '';
      return;
    }

    const done = jobs.filter((j) => j.status === 'completed').length;
    const active = jobs.filter((j) => ['queued', 'running'].includes(j.status)).length;
    const total = jobs.length;
    const cost = jobs.reduce((sum, j) => sum + Number(j.costUsd || 0), 0);
    el.textContent = `${done}/${total} done | ${active} active | $${cost.toFixed(3)}`;
  }

  function resultCard(job) {
    const styleTag = job.styleLabel ? `<span class="tag tag-style">${job.styleLabel}</span>` : '';
    const quality = Number(job.qualityScore || 0);
    const qualityPct = Math.max(0, Math.min(100, Math.round(quality * 100)));
    const qClass = qualityClass(quality);

    return `
      <div class="card">
        <div style="position:relative;margin-bottom:10px">
          <img src="/api/jobs/${job.id}/result-thumbnail?t=${Date.now()}" alt="Result" style="width:100%;border-radius:8px;display:block;background:#f8fafc" loading="lazy" />
        </div>
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:8px">
          <span class="tag tag-model">${job.modelLabel || job.model}</span>
          ${styleTag}
          <span class="text-xs text-muted">v${job.variant || 1}</span>
        </div>
        <div class="quality-meter" style="margin-bottom:8px">
          <div class="quality-fill ${qClass}" style="width:${qualityPct}%"></div>
        </div>
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
          <span class="text-sm text-muted">Quality ${fmtPct(quality)}</span>
          <span class="text-sm text-muted">${fmtUsd(job.costUsd || 0)}</span>
        </div>
        <div style="display:flex;gap:8px">
          <a class="btn btn-secondary btn-sm" href="/api/jobs/${job.id}/result-image" target="_blank" rel="noopener">View</a>
          <a class="btn btn-primary btn-sm" href="/api/jobs/${job.id}/result-image" download>Download</a>
        </div>
      </div>
    `;
  }

  function renderResults() {
    const grid = byId('resultsGrid');
    if (!grid) return;

    const completed = Array.from(state.jobs.values())
      .filter((j) => j.status === 'completed')
      .sort((a, b) => (b.completedAtMs || 0) - (a.completedAtMs || 0));

    if (!completed.length) {
      grid.innerHTML = '<div class="text-muted">No results yet</div>';
      return;
    }

    grid.innerHTML = completed.map(resultCard).join('');
  }

  async function cancelAllActive() {
    const active = Array.from(state.jobs.values()).filter((j) => ['queued', 'running'].includes(j.status));
    if (!active.length) return;

    await Promise.allSettled(
      active.map((job) => API.post(`/api/jobs/${job.id}/cancel`, {}))
    );

    active.forEach((job) => {
      job.status = 'cancelled';
      job.stage = 'done';
      job.message = 'Cancelled';
      job.completedAtMs = Date.now();
    });

    window.Toast.info('Cancelled all active jobs');
    renderAll();
  }

  function startHeartbeatRender() {
    if (state.renderTimer) clearInterval(state.renderTimer);
    state.renderTimer = setInterval(() => {
      // refresh timers/progress row
      renderPipeline();
      updatePipelineSummary();
    }, 1000);
  }

  async function init() {
    initShell();
    renderIteratePage();
    startHeartbeatRender();

    try {
      await Promise.all([loadBooks(), loadModels(), loadPrompts(), updateHeader()]);
      window.Toast.success('Iterate ready');
      renderAll();
    } catch (err) {
      console.error(err);
      window.Toast.error(`Failed to initialize iterate page: ${err.message}`);
    }

    // restore recent active/queued jobs so pipeline survives refresh
    try {
      const recent = await API.get('/api/jobs?limit=100');
      recent
        .filter((j) => ['queued', 'running'].includes(j.status))
        .forEach((j) => {
          const modelCfg = state.models.find((m) => m.id === j.model) || { label: j.model };
          const book = state.books.find((b) => b.id === j.book_id) || { id: j.book_id, title: 'Unknown', author: '' };
          state.jobs.set(j.id, {
            id: j.id,
            book,
            model: j.model,
            modelLabel: modelCfg.label,
            variant: j.variant || 1,
            styleLabel: null,
            status: j.status === 'queued' ? 'queued' : 'running',
            stage: j.status === 'queued' ? 'queued' : 'generating',
            message: j.status,
            startedAtMs: Date.parse(j.started_at || j.created_at || new Date().toISOString()),
            completedAtMs: null,
            costUsd: Number(j.cost_usd || 0),
            qualityScore: typeof j.quality_score === 'number' ? j.quality_score : null,
            compositeVerified: false,
          });
          attachJobEvents(j.id);
        });
      renderAll();
    } catch (err) {
      console.warn('Active job restore failed:', err);
    }

    // refresh header stats periodically
    setInterval(updateHeader, 15000);
  }

  document.addEventListener('DOMContentLoaded', init);
})();
