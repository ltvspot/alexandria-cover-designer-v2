// review.js — Review and approve generated variants
window.Pages = window.Pages || {};
window.Pages.review = {
  _filter: 'all',

  async render() {
    const content = document.getElementById('content');
    const books = await DB.dbGetAll('books');
    const jobs = await DB.dbGetAll('jobs');
    const winners = await DB.dbGetAll('winners');
    const winnerMap = new Map(winners.map(w => [w.book_id, w]));

    const bookJobs = new Map();
    jobs.filter(j => j.status === 'completed').forEach(j => {
      if (!bookJobs.has(j.book_id)) bookJobs.set(j.book_id, []);
      bookJobs.get(j.book_id).push(j);
    });

    let filteredBooks = books;
    if (this._filter === 'has-variants') {
      filteredBooks = books.filter(b => bookJobs.has(b.id));
    } else if (this._filter === 'needs-review') {
      filteredBooks = books.filter(b => bookJobs.has(b.id) && !winnerMap.has(b.id));
    } else if (this._filter === 'approved') {
      filteredBooks = books.filter(b => winnerMap.has(b.id));
    }

    content.innerHTML = `
      <div class="flex items-center justify-between mb-16">
        <div class="filters-bar">
          ${['all', 'has-variants', 'needs-review', 'approved'].map(f => 
            `<button class="filter-chip ${this._filter === f ? 'active' : ''}" data-filter="${f}">
              ${f === 'all' ? 'All' : f === 'has-variants' ? 'Has Variants' : f === 'needs-review' ? 'Needs Review' : 'Approved'}
            </button>`
          ).join('')}
        </div>
        <div class="flex gap-8 items-center">
          <a href="https://drive.google.com/drive/folders/1vOGdGjryzErrzB0kT3qmu3PJrRLOoqBg" target="_blank" class="btn btn-primary btn-sm" style="text-decoration:none">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right:4px"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
            Winner Covers (Drive)
          </a>
          <button class="btn btn-secondary btn-sm" id="downloadZipBtn" title="Download selected covers as ZIP">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right:4px"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            Download ZIP
          </button>
          <button class="btn btn-secondary btn-sm" id="batchAutoApprove">Batch Auto-Approve</button>
        </div>
      </div>

      <div id="autoApprovePanel" style="display:none" class="card mb-16">
        <div class="card-title mb-16">Batch Auto-Approve</div>
        <div class="form-group">
          <label class="form-label">Quality threshold: <span id="thresholdVal">60</span>%</label>
          <input type="range" min="0" max="100" value="60" id="thresholdSlider">
        </div>
        <p class="text-sm text-muted mb-16" id="autoApprovePreview">0 books would be auto-approved</p>
        <button class="btn btn-primary" id="runAutoApprove">Apply Auto-Approve</button>
      </div>

      ${filteredBooks.length === 0 ? `
        <div class="empty-state">
          <h3>No books to review</h3>
          <p>${books.length === 0 ? 'Sync your catalog first' : 'Generate some illustrations to review them here'}</p>
        </div>
      ` : `
        <div class="grid-auto" id="reviewGrid">
          ${filteredBooks.map(book => {
            const bJobs = bookJobs.get(book.id) || [];
            const winner = winnerMap.get(book.id);
            const bestJob = bJobs.sort((a, b) => (b.quality_score || 0) - (a.quality_score || 0))[0];
            let thumbSrc = '';
            if (winner) {
              const wJob = bJobs.find(j => j.id === winner.job_id);
              if (wJob && wJob.generated_image_blob) thumbSrc = getBlobUrl(wJob.generated_image_blob, `gen-${wJob.id}`);
            } else if (bestJob && bestJob.generated_image_blob) {
              thumbSrc = getBlobUrl(bestJob.generated_image_blob, `gen-${bestJob.id}`);
            }

            return `
              <div class="book-card" data-book-id="${book.id}" style="position:relative">
                <label class="book-select-check" onclick="event.stopPropagation()" title="Select for ZIP download" style="position:absolute;top:6px;left:6px;z-index:2;cursor:pointer">
                  <input type="checkbox" class="book-zip-cb" data-book-id="${book.id}" style="width:16px;height:16px;cursor:pointer" onclick="event.stopPropagation()">
                </label>
                <div class="book-thumb" style="position:relative">
                  ${thumbSrc ? `<img src="${thumbSrc}" style="width:100%;height:100%;object-fit:cover" loading="lazy">` : `<span>📖</span>`}
                </div>
                <div class="book-info">
                  <div class="book-title">${book.title}</div>
                  <div class="book-author">${book.author || '—'}</div>
                  <div style="display:flex;justify-content:space-between;align-items:center;margin-top:6px">
                    <span class="text-xs text-muted">${bJobs.length} variant${bJobs.length !== 1 ? 's' : ''}</span>
                    ${winner ? '<span class="tag tag-status">Approved</span>' : bJobs.length > 0 ? '<span class="tag tag-pending">Review</span>' : '<span class="tag tag-queued">No variants</span>'}
                  </div>
                </div>
              </div>
            `;
          }).join('')}
        </div>
      `}
    `;

    document.querySelectorAll('.filter-chip').forEach(btn => {
      btn.addEventListener('click', () => {
        this._filter = btn.dataset.filter;
        this.render();
      });
    });

    document.getElementById('downloadZipBtn').addEventListener('click', () => this.downloadZip(jobs, books, winnerMap));

    document.querySelectorAll('.book-card').forEach(card => {
      card.addEventListener('click', () => this.showBookVariants(card.dataset.bookId));
    });

    document.getElementById('batchAutoApprove').addEventListener('click', () => {
      const panel = document.getElementById('autoApprovePanel');
      panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
      this.updateAutoApprovePreview(bookJobs, winnerMap);
    });

    const slider = document.getElementById('thresholdSlider');
    slider.addEventListener('input', () => {
      document.getElementById('thresholdVal').textContent = slider.value;
      this.updateAutoApprovePreview(bookJobs, winnerMap);
    });

    document.getElementById('runAutoApprove').addEventListener('click', () => this.runAutoApprove(bookJobs, winnerMap));
  },

  updateAutoApprovePreview(bookJobs, winnerMap) {
    const threshold = parseInt(document.getElementById('thresholdSlider').value) / 100;
    let count = 0;
    for (const [bookId, bJobs] of bookJobs) {
      if (winnerMap.has(bookId)) continue;
      const best = bJobs.sort((a, b) => (b.quality_score || 0) - (a.quality_score || 0))[0];
      if (best && (best.quality_score || 0) >= threshold) count++;
    }
    document.getElementById('autoApprovePreview').textContent = `${count} book${count !== 1 ? 's' : ''} would be auto-approved`;
  },

  async runAutoApprove(bookJobs, winnerMap) {
    const threshold = parseInt(document.getElementById('thresholdSlider').value) / 100;
    let count = 0;
    for (const [bookId, bJobs] of bookJobs) {
      if (winnerMap.has(bookId)) continue;
      const best = bJobs.sort((a, b) => (b.quality_score || 0) - (a.quality_score || 0))[0];
      if (best && (best.quality_score || 0) >= threshold) {
        await DB.dbPut('winners', {
          book_id: bookId,
          job_id: best.id,
          variant_index: best.variant,
          quality_score: best.quality_score,
          auto_approved: true,
          selected_at: new Date().toISOString()
        });
        count++;
      }
    }
    Toast.success(`Auto-approved ${count} books`);
    this.render();
  },

  async downloadZip(allJobs, books, winnerMap) {
    const checked = [...document.querySelectorAll('.book-zip-cb:checked')];
    if (checked.length === 0) {
      Toast.warning('Check at least one book to include in the ZIP');
      return;
    }
    if (typeof JSZip === 'undefined') {
      Toast.error('JSZip not loaded — check internet connection');
      return;
    }
    const zip = new JSZip();
    let added = 0;
    for (const cb of checked) {
      const bookId = cb.dataset.bookId;
      const book = books.find(b => b.id === bookId);
      const bJobs = allJobs.filter(j => j.book_id === bookId && j.status === 'completed');
      const winner = winnerMap.get(bookId);
      const winnerJob = winner ? bJobs.find(j => j.id === winner.job_id) : null;
      const bestJob = winnerJob || bJobs.sort((a, b) => (b.quality_score || 0) - (a.quality_score || 0))[0];
      if (!bestJob) continue;

      const safeTitle = (book?.title || bookId).replace(/[^a-z0-9_\-\s]/gi, '_').substring(0, 50);
      const folder = zip.folder(safeTitle);

      if (bestJob.generated_image_blob) {
        const src = typeof bestJob.generated_image_blob === 'string'
          ? bestJob.generated_image_blob
          : URL.createObjectURL(bestJob.generated_image_blob);
        try {
          const resp = await fetch(src);
          const blob = await resp.blob();
          folder.file('illustration.jpg', blob);
        } catch(e) {}
      }

      if (bestJob.composited_image_blob) {
        const src = typeof bestJob.composited_image_blob === 'string'
          ? bestJob.composited_image_blob
          : URL.createObjectURL(bestJob.composited_image_blob);
        try {
          const resp = await fetch(src);
          const blob = await resp.blob();
          folder.file('cover.jpg', blob);
        } catch(e) {}
      }

      const meta = {
        title: book?.title || '',
        author: book?.author || '',
        model: bestJob.model,
        variant: bestJob.variant,
        quality_score: bestJob.quality_score,
        cost_usd: bestJob.cost_usd,
        prompt: bestJob.prompt,
        completed_at: bestJob.completed_at,
        winner: !!winnerJob
      };
      folder.file('metadata.json', JSON.stringify(meta, null, 2));
      added++;
    }
    if (added === 0) {
      Toast.warning('No images found for selected books');
      return;
    }
    Toast.info(`Building ZIP for ${added} book${added !== 1 ? 's' : ''}...`);
    const blob = await zip.generateAsync({ type: 'blob' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `winner-covers-${new Date().toISOString().substring(0,10)}.zip`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    Toast.success(`Downloaded ZIP with ${added} book${added !== 1 ? 's' : ''}`);
  },

  async downloadWinner(bookId, jobs) {
    const winner = await DB.dbGet('winners', bookId);
    const book = await DB.dbGet('books', bookId);
    const bJobs = jobs || (await DB.dbGetByIndex('jobs', 'book_id', bookId)).filter(j => j.status === 'completed');
    const winnerJob = winner ? bJobs.find(j => j.id === winner.job_id) : null;
    const bestJob = winnerJob || bJobs.sort((a, b) => (b.quality_score || 0) - (a.quality_score || 0))[0];
    if (!bestJob) { Toast.warning('No completed variants for this book'); return; }
    const blob = bestJob.composited_image_blob || bestJob.generated_image_blob;
    if (!blob) { Toast.warning('No image available'); return; }
    const url = typeof blob === 'string' ? blob : URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(book?.title || bookId).replace(/[^a-z0-9_\-\s]/gi, '_')}_winner.jpg`;
    a.click();
    if (typeof blob !== 'string') setTimeout(() => URL.revokeObjectURL(url), 1000);
    Toast.success(`Downloaded winner cover for "${book?.title || bookId}"`);
  },

  async showBookVariants(bookId) {
    const book = await DB.dbGet('books', bookId);
    const jobs = (await DB.dbGetByIndex('jobs', 'book_id', bookId)).filter(j => j.status === 'completed');
    const winner = await DB.dbGet('winners', bookId);

    if (jobs.length === 0) {
      Toast.info('No completed variants for this book');
      return;
    }

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal" style="max-width:800px">
        <div class="modal-title">${book.title} — Select Winner</div>
        <div class="grid-auto" style="grid-template-columns:repeat(auto-fill,minmax(200px,1fr))">
          ${await Promise.all(jobs.map(async (job) => {
            const isWinner = winner && winner.job_id === job.id;
            const thumbSrc = job.generated_image_blob ? getBlobUrl(job.generated_image_blob, `gen-${job.id}`) : '';
            const q = job.quality_score || 0;
            const qClass = q >= 0.7 ? 'high' : q >= 0.4 ? 'medium' : 'low';
            return `
              <div class="result-card ${isWinner ? 'selected' : ''}" data-job-id="${job.id}" style="cursor:pointer">
                ${thumbSrc ? `<img class="thumb" src="${thumbSrc}" loading="lazy">` : '<div class="thumb">—</div>'}
                <div class="card-body">
                  <span class="tag tag-model">${OpenRouter.MODEL_LABELS[job.model] || job.model}</span>
                  <div class="quality-meter mt-8">
                    <div class="quality-bar"><div class="quality-fill ${qClass}" style="width:${q*100}%"></div></div>
                    <span class="text-xs">${Math.round(q*100)}%</span>
                  </div>
                  ${isWinner ? '<div class="tag tag-gold mt-8">Winner</div>' : ''}
                  <div style="margin-top:6px">
                    <button class="btn btn-sm btn-secondary dl-variant-btn" data-job-id="${job.id}" onclick="event.stopPropagation()">Download</button>
                  </div>
                </div>
              </div>
            `;
          })).then(a => a.join(''))}
        </div>
        <div class="modal-actions">
          <button class="btn btn-primary" id="downloadWinnerBtn">⇓ Download Winner</button>
          <button class="btn btn-secondary" id="closeVariants">Close</button>
        </div>
      </div>
    `;

    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    overlay.querySelector('#closeVariants').addEventListener('click', () => overlay.remove());
    overlay.querySelector('#downloadWinnerBtn').addEventListener('click', () => this.downloadWinner(bookId, jobs));

    overlay.querySelectorAll('.dl-variant-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const job = jobs.find(j => j.id === btn.dataset.jobId);
        if (!job) return;
        const blob = job.composited_image_blob || job.generated_image_blob;
        if (!blob) { Toast.warning('No image for this variant'); return; }
        const url = typeof blob === 'string' ? blob : URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${(book?.title || bookId).replace(/[^a-z0-9_\-\s]/gi, '_')}_${job.model}_v${job.variant}.jpg`;
        a.click();
        if (typeof blob !== 'string') setTimeout(() => URL.revokeObjectURL(url), 1000);
      });
    });

    overlay.querySelectorAll('.result-card').forEach(card => {
      card.addEventListener('click', async () => {
        const jobId = card.dataset.jobId;
        const job = jobs.find(j => j.id === jobId);
        if (!job) return;
        await DB.dbPut('winners', {
          book_id: bookId,
          job_id: jobId,
          variant_index: job.variant,
          quality_score: job.quality_score,
          auto_approved: false,
          selected_at: new Date().toISOString()
        });
        Toast.success(`Selected winner for "${book.title}"`);
        overlay.remove();
        this.render();
      });
    });

    document.body.appendChild(overlay);
  }
};