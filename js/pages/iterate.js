// iterate.js — Main generation page
// A1: Live heartbeat timer
// A2: Stage sub-status text
// A3: Abort/cancel button per job
// C9: Show composite thumbnail (not raw)
// F18: Per-job running cost tracker
// F19: Error details expandable
// F20: Composite vs raw toggle
window.Pages = window.Pages || {};
window.Pages.iterate = {
  async render() {
    const content = document.getElementById('content');
    const books = await DB.dbGetAll('books');
    const prompts = await DB.dbGetAll('prompts');

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
          <div class="form-group">
            <label class="form-label">Book</label>
            <select class="form-select" id="bookSelect">
              <option value="">— Select a book —</option>
              ${books.sort((a,b) => (a.number||'').localeCompare(b.number||'', undefined, {numeric:true})).map(b => 
                `<option value="${b.id}">${b.number ? b.number + ' — ' : ''}${b.title}${b.author ? ' by ' + b.author : ''}</option>`
              ).join('')}
            </select>
            ${books.length === 0 ? '<span class="form-hint">Syncing from Drive... books will appear shortly.</span>' : `<span class="form-hint">${books.length} books loaded</span>`}
          </div>
          <div class="form-group" style="flex:0 0 auto">
            <label class="form-label">&nbsp;</label>
            <button class="btn btn-secondary btn-sm" id="syncQuickBtn">Sync</button>
          </div>
        </div>

        <div class="form-group">
          <label class="form-label">Models <span class="text-xs text-muted">(best → budget, top → bottom)</span></label>
          <div class="checkbox-group" id="modelCheckboxes">
            ${OpenRouter.MODELS.map((m, i) => `
              <div class="checkbox-item">
                <input type="checkbox" id="m_${i}" value="${m.id}" ${i < 3 ? 'checked' : ''}>
                <label for="m_${i}">${m.label} ($${m.cost})</label>
              </div>
            `).join('')}
          </div>
        </div>

        <div id="advancedOptions" style="display:block">
          <div class="form-row mb-16">
            <div class="form-group">
              <label class="form-label">Variants per model</label>
              <select class="form-select" id="variantCount">
                ${[1,2,3,4,5,6,7,8,9,10].map(n => `<option value="${n}" ${n===1?'selected':''}>${n}</option>`).join('')}
              </select>
            </div>
            <div class="form-group">
              <label class="form-label">Prompt template</label>
              <select class="form-select" id="promptTemplate">
                <option value="">— Default prompt —</option>
                ${prompts.map(p => `<option value="${p.id}">${p.name}</option>`).join('')}
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
          <button class="btn btn-secondary btn-sm" id="cancelAllBtn" style="display:none">Cancel All</button>
          <span class="text-sm text-muted" id="costEstimate" style="line-height:36px"></span>
        </div>
      </div>

      <!-- Pipeline Status -->
      <div id="pipelineArea" style="display:none" class="card">
        <div class="card-header" style="margin-bottom:12px">
          <span class="card-title">Generation Progress</span>
          <span class="text-sm text-muted" id="pipelineSummary"></span>
        </div>
        <div id="pipelineSteps"></div>
      </div>

      <!-- Results Grid -->
      <div id="resultsArea">
        <div class="card-header" style="margin-bottom:12px">
          <span class="card-title">Results</span>
        </div>
        <div class="grid-auto" id="resultsGrid"></div>
      </div>
    `;

    this.bindEvents(books, prompts);
    this.loadExistingResults();
  },

  _advancedMode: true,
  _trackedJobs: [],

  bindEvents(books, prompts) {
    const modeToggle = document.getElementById('modeToggle');
    const advOpts = document.getElementById('advancedOptions');
    
    modeToggle.addEventListener('click', () => {
      this._advancedMode = !this._advancedMode;
      modeToggle.classList.toggle('on', this._advancedMode);
      advOpts.style.display = this._advancedMode ? 'block' : 'none';
    });

    const updateCost = () => {
      const models = [...document.querySelectorAll('#modelCheckboxes input:checked')].map(c => c.value);
      const variants = this._advancedMode ? parseInt(document.getElementById('variantCount').value) : 1;
      const cost = models.reduce((sum, m) => sum + (OpenRouter.MODEL_COSTS[m] || 0), 0) * variants;
      document.getElementById('costEstimate').textContent = models.length > 0 ? `Est. cost: $${cost.toFixed(3)}` : '';
    };
    document.querySelectorAll('#modelCheckboxes input').forEach(c => c.addEventListener('change', updateCost));
    if (document.getElementById('variantCount')) {
      document.getElementById('variantCount').addEventListener('change', updateCost);
    }
    updateCost();

    const promptSelect = document.getElementById('promptTemplate');
    if (promptSelect) {
      promptSelect.addEventListener('change', async () => {
        const id = parseInt(promptSelect.value);
        if (!id) return;
        const tmpl = prompts.find(p => p.id === id);
        if (tmpl) {
          document.getElementById('customPrompt').value = tmpl.template;
        }
      });
    }

    document.getElementById('syncQuickBtn').addEventListener('click', async () => {
      const btn = document.getElementById('syncQuickBtn');
      btn.disabled = true;
      btn.textContent = 'Syncing...';
      try {
        const catalog = await Drive.refreshCatalogCache();
        document.getElementById('syncStatus').textContent = `${catalog.count} books`;
        Toast.success(`Synced ${catalog.count} books from Drive`);
        this.render();
      } catch (e) {
        try {
          const books = await Drive.syncCatalog((msg, done, total) => {
            btn.textContent = total > 0 ? `${done}/${total}` : msg;
            document.getElementById('syncStatus').textContent = total > 0 ? `${done}/${total} books` : msg;
          });
          Toast.success(`Synced ${books.length} books from Drive`);
          this.render();
        } catch (e2) {
          Toast.error(`Sync failed: ${e2.message}`);
        }
      } finally {
        btn.disabled = false;
        btn.textContent = 'Sync';
      }
    });

    document.getElementById('cancelAllBtn').addEventListener('click', () => {
      JobQueue.cancelAll();
      document.getElementById('cancelAllBtn').style.display = 'none';
      Toast.info('All jobs cancelled');
    });

    document.getElementById('generateBtn').addEventListener('click', () => this.handleGenerate(books));
  },

  async handleGenerate(books) {
    const bookId = document.getElementById('bookSelect').value;
    if (!bookId) { Toast.warning('Select a book first'); return; }

    const book = books.find(b => b.id === bookId);
    const models = [...document.querySelectorAll('#modelCheckboxes input:checked')].map(c => c.value);
    if (models.length === 0) { Toast.warning('Select at least one model'); return; }

    const variants = this._advancedMode ? parseInt(document.getElementById('variantCount').value) : 1;
    const customPrompt = this._advancedMode ? document.getElementById('customPrompt').value.trim() : '';

    const useCustomPrompt = customPrompt && customPrompt.length > 0;
    let resolvedCustomPrompt = customPrompt;
    if (useCustomPrompt) {
      resolvedCustomPrompt = customPrompt.replace(/\{title\}/g, book.title).replace(/\{author\}/g, book.author || '');
    }

    const totalJobs = models.length * variants;
    const styles = StyleDiversifier.selectDiverseStyles(totalJobs);
    let styleIndex = 0;

    document.getElementById('pipelineArea').style.display = 'block';
    document.getElementById('cancelAllBtn').style.display = 'inline-flex';

    const jobs = [];
    for (const model of models) {
      for (let v = 0; v < variants; v++) {
        const style = styles[styleIndex];
        const prompt = useCustomPrompt
          ? resolvedCustomPrompt
          : StyleDiversifier.buildDiversifiedPrompt(null, book, style);

        const job = {
          id: uuid(),
          book_id: bookId,
          model: model,
          variant: v + 1,
          status: 'queued',
          prompt: prompt,
          style_id: useCustomPrompt ? null : style.id,
          style_label: useCustomPrompt ? null : style.label,
          quality_score: null,
          cost_usd: 0,
          generated_image_blob: null,
          composited_image_blob: null,
          started_at: null,
          completed_at: null,
          error: null,
          results_json: null,
          _elapsed: 0,
          _subStatus: '',
          _compositeFailed: false,
          _compositeError: null,
          created_at: new Date().toISOString()
        };
        await DB.dbPut('jobs', job);
        jobs.push(job);
        styleIndex++;
      }
    }

    this._trackedJobs = jobs;
    this.updatePipeline(jobs);

    JobQueue.addBatch(jobs);

    const listener = () => {
      this.updatePipeline(this._trackedJobs);
      this.loadExistingResults();

      if (JobQueue.running.size === 0 && JobQueue.queue.length === 0) {
        const cancelBtn = document.getElementById('cancelAllBtn');
        if (cancelBtn) cancelBtn.style.display = 'none';
      }
    };
    JobQueue.onChange(listener);

    Toast.info(`Queued ${jobs.length} generation${jobs.length > 1 ? 's' : ''} (${JobQueue.MAX_CONCURRENT} parallel)`);
  },

  updatePipeline(jobs) {
    const area = document.getElementById('pipelineSteps');
    const summary = document.getElementById('pipelineSummary');
    if (!area) return;

    const stages = ['queued', 'downloading_cover', 'generating', 'retrying', 'scoring', 'compositing', 'completed'];
    const stageLabels = {
      queued: 'Queued', downloading_cover: 'Cover', generating: 'Generating',
      retrying: 'Retrying', scoring: 'Scoring', compositing: 'Compositing', completed: 'Done'
    };

    const completed = jobs.filter(j => j.status === 'completed').length;
    const failed = jobs.filter(j => j.status === 'failed').length;
    const running = jobs.filter(j => !['queued', 'completed', 'failed'].includes(j.status)).length;
    const totalCost = jobs.reduce((s, j) => s + (j.cost_usd || 0), 0);
    if (summary) {
      summary.textContent = `${completed}/${jobs.length} done${failed ? `, ${failed} failed` : ''} | ${running} active | $${totalCost.toFixed(3)}`;
    }

    area.innerHTML = jobs.map(job => {
      const currentIdx = stages.indexOf(job.status);
      const failedIdx = job.status === 'failed' ? -1 : currentIdx;
      const modelLabel = OpenRouter.MODEL_LABELS[job.model] || job.model;
      const isActive = !['queued', 'completed', 'failed'].includes(job.status);
      const elapsed = job._elapsed || 0;

      return `
        <div class="pipeline-row" style="margin-bottom:6px;padding:6px 0;border-bottom:1px solid #f1f5f9">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
            <span class="tag tag-model">${modelLabel}</span>
            ${job.style_label ? `<span class="tag tag-style">${job.style_label}</span>` : ''}
            <span class="text-xs text-muted">v${job.variant}</span>
            ${isActive ? `
              <span class="heartbeat-pulse"></span>
              <span class="text-xs" style="color:#c5a55a;font-weight:600;font-variant-numeric:tabular-nums">${elapsed}s</span>
            ` : ''}
            ${job.status === 'completed' ? `<span class="tag tag-status">Done</span>` : ''}
            ${job.status === 'failed' ? `<span class="tag tag-failed">Failed</span>` : ''}
            ${isActive ? `<button class="btn-cancel-job" onclick="JobQueue.abortJob('${job.id}')">&#x2715;</button>` : ''}
            ${job.cost_usd > 0 ? `<span class="text-xs text-muted">$${job.cost_usd.toFixed(3)}</span>` : ''}
          </div>
          <div class="pipeline" style="margin-bottom:2px">
            ${stages.map((s, i) => {
              let cls = 'pipeline-step';
              if (job.status === 'failed') cls += i <= currentIdx ? ' error' : '';
              else if (i < currentIdx) cls += ' done';
              else if (i === currentIdx) cls += ' active';
              return `<span class="${cls}">${stageLabels[s]}</span>${i < stages.length - 1 ? '<span class="pipeline-arrow">→</span>' : ''}`;
            }).join('')}
          </div>
          ${job._subStatus ? `<div class="text-xs text-muted" style="margin-top:2px;font-style:italic">${job._subStatus}</div>` : ''}
          ${job.status === 'failed' && job.error ? `<div class="text-xs" style="color:#ef4444;margin-top:2px">${job.error.substring(0, 120)}</div>` : ''}
        </div>
      `;
    }).join('');
  },

  async loadExistingResults() {
    const grid = document.getElementById('resultsGrid');
    if (!grid) return;

    const bookId = document.getElementById('bookSelect')?.value;
    let jobs;
    if (bookId) {
      jobs = await DB.dbGetByIndex('jobs', 'book_id', bookId);
    } else {
      jobs = await DB.dbGetAll('jobs');
    }

    jobs = jobs.filter(j => j.status === 'completed' || j.status === 'failed')
               .sort((a, b) => new Date(b.completed_at || b.created_at) - new Date(a.completed_at || a.created_at))
               .slice(0, 20);

    if (jobs.length === 0) {
      grid.innerHTML = '<div class="empty-state"><h3>No results yet</h3><p>Select a book and generate illustrations</p></div>';
      return;
    }

    grid.innerHTML = await Promise.all(jobs.map(async (job) => {
      const book = await DB.dbGet('books', job.book_id);

      const hasComposite = !!job.composited_image_blob;
      const hasGenerated = !!job.generated_image_blob;
      let thumbSrc = '';
      if (hasComposite) {
        thumbSrc = getBlobUrl(job.composited_image_blob, `comp-${job.id}`);
      } else if (hasGenerated) {
        thumbSrc = getBlobUrl(job.generated_image_blob, `gen-${job.id}`);
      }

      const q = job.quality_score || 0;
      const qClass = q >= 0.7 ? 'high' : q >= 0.4 ? 'medium' : 'low';
      const modelLabel = OpenRouter.MODEL_LABELS[job.model] || job.model;
      const elapsed = job.started_at && job.completed_at 
        ? Math.round((new Date(job.completed_at) - new Date(job.started_at)) / 1000) + 's'
        : '—';

      let compositeWarning = '';
      let errorDetails = '';
      try {
        const results = job.results_json ? JSON.parse(job.results_json) : {};
        if (results.cover_failed) compositeWarning = 'Cover download failed';
        else if (results.composite_failed) compositeWarning = results.composite_error || 'Compositing failed';
      } catch(e) {}
      if (job.status === 'failed') errorDetails = job.error || 'Unknown error';

      return `
        <div class="result-card" data-job-id="${job.id}">
          ${thumbSrc 
            ? `<img class="thumb" src="${thumbSrc}" alt="${hasComposite ? 'Composited cover' : 'Generated illustration'}" loading="lazy">`
            : `<div class="thumb" style="display:flex;align-items:center;justify-content:center;color:#94a3b8;font-size:12px">${job.status === 'failed' ? 'Failed' : 'No image'}</div>`
          }
          <div class="card-body">
            <div style="display:flex;justify-content:space-between;align-items:center">
              <div style="display:flex;gap:4px;align-items:center;flex-wrap:wrap">
                <span class="tag tag-model">${modelLabel}</span>
                ${job.style_label ? `<span class="tag tag-style">${job.style_label}</span>` : ''}
              </div>
              <span class="tag ${job.status === 'completed' ? 'tag-status' : 'tag-failed'}">${job.status}</span>
            </div>
            ${job.status === 'completed' ? `
              <div class="card-meta">
                <div class="quality-meter">
                  <div class="quality-bar"><div class="quality-fill ${qClass}" style="width:${q*100}%"></div></div>
                  <span>${Math.round(q*100)}%</span>
                </div>
                <span>$${(job.cost_usd||0).toFixed(3)}</span>
                <span>${elapsed}</span>
              </div>
              ${compositeWarning ? `<div class="text-xs" style="color:#f59e0b;margin-top:4px">⚠ ${compositeWarning}</div>` : ''}
              ${job.retries > 0 ? `<div class="text-xs text-muted" style="margin-top:2px">${job.retries} retries</div>` : ''}
            ` : ''}
            ${errorDetails ? `
              <div class="error-expandable" style="margin-top:6px">
                <div class="text-xs" style="color:#ef4444;cursor:pointer" onclick="this.nextElementSibling.style.display=this.nextElementSibling.style.display==='none'?'block':'none'">⚠ ${errorDetails.substring(0, 60)}${errorDetails.length > 60 ? '...' : ''} <span style="text-decoration:underline">details</span></div>
                <div style="display:none;margin-top:4px;padding:6px;background:#fef2f2;border-radius:4px;font-size:11px;word-break:break-all;color:#991b1b">${errorDetails}</div>
              </div>
            ` : ''}
            <div style="margin-top:8px;display:flex;gap:4px;flex-wrap:wrap">
              ${hasComposite ? `<button class="btn btn-sm btn-secondary" onclick="Pages.iterate.downloadComposite('${job.id}')">Download Cover</button>` : ''}
              ${hasGenerated && !hasComposite ? `<button class="btn btn-sm btn-secondary" onclick="Pages.iterate.downloadGenerated('${job.id}')">Download</button>` : ''}
              ${hasComposite ? `<button class="btn btn-sm btn-secondary" onclick="Pages.iterate.viewFull('${job.id}', 'composite')">View Cover</button>` : ''}
              ${hasGenerated ? `<button class="btn btn-sm btn-secondary" onclick="Pages.iterate.viewFull('${job.id}', 'raw')">View Raw</button>` : ''}
              ${job.prompt ? `<button class="btn btn-sm btn-primary" onclick="Pages.iterate.savePromptFromJob('${job.id}')">&#9733; Save</button>` : ''}
            </div>
          </div>
        </div>
      `;
    })).then(arr => arr.join(''));
  },

  async downloadComposite(jobId) {
    const job = await DB.dbGet('jobs', jobId);
    if (!job || !job.composited_image_blob) { Toast.warning('No composite available'); return; }
    const book = await DB.dbGet('books', job.book_id);
    const url = typeof job.composited_image_blob === 'string' 
      ? job.composited_image_blob 
      : URL.createObjectURL(job.composited_image_blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${book?.title || 'cover'}_${job.model}_v${job.variant}.jpg`;
    a.click();
    if (typeof job.composited_image_blob !== 'string') {
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  },

  async downloadGenerated(jobId) {
    const job = await DB.dbGet('jobs', jobId);
    if (!job || !job.generated_image_blob) { Toast.warning('No image available'); return; }
    const book = await DB.dbGet('books', job.book_id);
    const url = typeof job.generated_image_blob === 'string'
      ? job.generated_image_blob
      : URL.createObjectURL(job.generated_image_blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${book?.title || 'illustration'}_${job.model}_v${job.variant}.jpg`;
    a.click();
    if (typeof job.generated_image_blob !== 'string') {
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  },

  async savePromptFromJob(jobId) {
    const job = await DB.dbGet('jobs', jobId);
    if (!job || !job.prompt) { Toast.warning('No prompt on this job'); return; }
    const book = await DB.dbGet('books', job.book_id);
    const modelLabel = OpenRouter.MODEL_LABELS[job.model] || job.model;
    const name = `${book?.title || 'Untitled'} — ${modelLabel}`;
    await DB.dbPut('prompts', {
      name: name,
      category: 'Saved',
      template: job.prompt,
      negative_prompt: '',
      style_profile: '',
      created_at: new Date().toISOString()
    });
    Toast.success(`Prompt saved as "${name}"`);
  },

  async viewFull(jobId, mode) {
    const job = await DB.dbGet('jobs', jobId);
    if (!job) return;

    const hasComposite = !!job.composited_image_blob;
    const hasGenerated = !!job.generated_image_blob;

    let imgSrc;
    if (mode === 'composite' && hasComposite) {
      imgSrc = getBlobUrl(job.composited_image_blob, `comp-${job.id}`);
    } else if (hasGenerated) {
      imgSrc = getBlobUrl(job.generated_image_blob, `gen-${job.id}`);
    } else {
      return;
    }

    const book = await DB.dbGet('books', job.book_id);
    const modelLabel = OpenRouter.MODEL_LABELS[job.model] || job.model;

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="view-modal">
        <div class="view-modal-header">
          <div>
            <span class="tag tag-model">${modelLabel}</span>
            <span class="text-sm text-muted" style="margin-left:8px">${book?.title || 'Unknown'} v${job.variant}</span>
            <span class="text-sm text-muted" style="margin-left:8px">${Math.round((job.quality_score || 0) * 100)}% quality</span>
          </div>
          <div style="display:flex;gap:6px;align-items:center">
            ${hasComposite && hasGenerated ? `
              <button class="btn btn-sm ${mode === 'composite' ? 'btn-primary' : 'btn-secondary'}" id="viewToggleComp">Cover</button>
              <button class="btn btn-sm ${mode === 'raw' ? 'btn-primary' : 'btn-secondary'}" id="viewToggleRaw">Raw</button>
            ` : ''}
            <button class="btn btn-sm btn-secondary" id="viewCloseBtn">&#x2715;</button>
          </div>
        </div>
        <div class="view-modal-body">
          <img id="viewModalImg" src="${imgSrc}" alt="Preview">
        </div>
      </div>
    `;
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    document.body.appendChild(overlay);

    document.getElementById('viewCloseBtn').addEventListener('click', () => overlay.remove());

    const compBtn = document.getElementById('viewToggleComp');
    const rawBtn = document.getElementById('viewToggleRaw');
    const img = document.getElementById('viewModalImg');

    if (compBtn && rawBtn) {
      compBtn.addEventListener('click', () => {
        img.src = getBlobUrl(job.composited_image_blob, `comp-${job.id}`);
        compBtn.className = 'btn btn-sm btn-primary';
        rawBtn.className = 'btn btn-sm btn-secondary';
      });
      rawBtn.addEventListener('click', () => {
        img.src = getBlobUrl(job.generated_image_blob, `gen-${job.id}`);
        rawBtn.className = 'btn btn-sm btn-primary';
        compBtn.className = 'btn btn-sm btn-secondary';
      });
    }
  }
};