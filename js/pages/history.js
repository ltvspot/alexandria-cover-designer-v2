// history.js — History table with filters, sort, pagination
window.Pages = window.Pages || {};
window.Pages.history = {
  _page: 1,
  _perPage: 20,
  _sort: { col: 'created_at', dir: 'desc' },
  _filters: { status: '', model: '', minQuality: 0, maxQuality: 100 },

  async render() {
    const content = document.getElementById('content');
    let jobs = await DB.dbGetAll('jobs');
    const books = await DB.dbGetAll('books');
    const bookMap = new Map(books.map(b => [b.id, b]));

    if (this._filters.status) jobs = jobs.filter(j => j.status === this._filters.status);
    if (this._filters.model) jobs = jobs.filter(j => j.model === this._filters.model);
    jobs = jobs.filter(j => {
      const q = (j.quality_score || 0) * 100;
      return q >= this._filters.minQuality && q <= this._filters.maxQuality;
    });

    const { col, dir } = this._sort;
    jobs.sort((a, b) => {
      let va = a[col], vb = b[col];
      if (col === 'title') { va = bookMap.get(a.book_id)?.title || ''; vb = bookMap.get(b.book_id)?.title || ''; }
      if (va == null) va = '';
      if (vb == null) vb = '';
      if (typeof va === 'number' && typeof vb === 'number') return dir === 'asc' ? va - vb : vb - va;
      return dir === 'asc' ? String(va).localeCompare(String(vb)) : String(vb).localeCompare(String(va));
    });

    const totalPages = Math.max(1, Math.ceil(jobs.length / this._perPage));
    if (this._page > totalPages) this._page = totalPages;
    const start = (this._page - 1) * this._perPage;
    const pageJobs = jobs.slice(start, start + this._perPage);

    const sortIcon = (c) => `<span class="sort-icon ${this._sort.col === c ? 'active' : ''}">${this._sort.col === c ? (this._sort.dir === 'asc' ? '▲' : '▼') : '⇅'}</span>`;

    content.innerHTML = `
      <div class="card">
        <div class="card-header">
          <span class="card-title">Generation History</span>
          <div class="flex gap-8">
            <button class="btn btn-secondary btn-sm" id="exportCsv">Export CSV</button>
            <span class="text-sm text-muted">${jobs.length} jobs</span>
          </div>
        </div>

        <div class="filters-bar mb-16">
          <select class="form-select" style="width:140px" id="filterStatus">
            <option value="">All Status</option>
            <option value="completed" ${this._filters.status === 'completed' ? 'selected' : ''}>Completed</option>
            <option value="failed" ${this._filters.status === 'failed' ? 'selected' : ''}>Failed</option>
            <option value="generating" ${this._filters.status === 'generating' ? 'selected' : ''}>Generating</option>
            <option value="queued" ${this._filters.status === 'queued' ? 'selected' : ''}>Queued</option>
          </select>
          <select class="form-select" style="width:180px" id="filterModel">
            <option value="">All Models</option>
            ${Object.entries(OpenRouter.MODEL_LABELS).map(([k,v]) => 
              `<option value="${k}" ${this._filters.model === k ? 'selected' : ''}>${v}</option>`
            ).join('')}
          </select>
          <div class="flex items-center gap-8">
            <span class="text-xs text-muted">Quality:</span>
            <input type="number" class="form-input" style="width:60px" value="${this._filters.minQuality}" id="filterMinQ" min="0" max="100">
            <span class="text-xs">—</span>
            <input type="number" class="form-input" style="width:60px" value="${this._filters.maxQuality}" id="filterMaxQ" min="0" max="100">
          </div>
        </div>

        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th data-col="title">Book ${sortIcon('title')}</th>
                <th data-col="model">Model ${sortIcon('model')}</th>
                <th data-col="variant">Var ${sortIcon('variant')}</th>
                <th data-col="status">Status ${sortIcon('status')}</th>
                <th data-col="quality_score">Quality ${sortIcon('quality_score')}</th>
                <th data-col="cost_usd">Cost ${sortIcon('cost_usd')}</th>
                <th data-col="created_at">Date ${sortIcon('created_at')}</th>
              </tr>
            </thead>
            <tbody>
              ${pageJobs.length === 0 ? '<tr><td colspan="7" style="text-align:center;color:#94a3b8;padding:32px">No jobs found</td></tr>' : ''}
              ${pageJobs.map(j => {
                const book = bookMap.get(j.book_id);
                const q = j.quality_score || 0;
                const qClass = q >= 0.7 ? 'high' : q >= 0.4 ? 'medium' : 'low';
                return `
                  <tr>
                    <td>${book?.title || j.book_id?.slice(0,8) || '—'}</td>
                    <td><span class="tag tag-model">${OpenRouter.MODEL_LABELS[j.model] || j.model}</span></td>
                    <td>${j.variant || 1}</td>
                    <td><span class="tag ${j.status === 'completed' ? 'tag-status' : j.status === 'failed' ? 'tag-failed' : 'tag-pending'}">${j.status}</span></td>
                    <td>
                      ${j.status === 'completed' ? `
                        <div class="quality-meter">
                          <div class="quality-bar"><div class="quality-fill ${qClass}" style="width:${q*100}%"></div></div>
                          <span>${Math.round(q*100)}%</span>
                        </div>
                      ` : '—'}
                    </td>
                    <td>$${(j.cost_usd || 0).toFixed(3)}</td>
                    <td>${formatDate(j.created_at)}</td>
                  </tr>
                `;
              }).join('')}
            </tbody>
          </table>
        </div>

        ${totalPages > 1 ? `
          <div class="pagination">
            <button class="page-btn" ${this._page <= 1 ? 'disabled' : ''} data-page="${this._page - 1}">‹ Prev</button>
            ${Array.from({length: Math.min(totalPages, 7)}, (_, i) => {
              const p = i + 1;
              return `<button class="page-btn ${p === this._page ? 'active' : ''}" data-page="${p}">${p}</button>`;
            }).join('')}
            ${totalPages > 7 ? `<span class="text-muted">...</span><button class="page-btn ${totalPages === this._page ? 'active' : ''}" data-page="${totalPages}">${totalPages}</button>` : ''}
            <button class="page-btn" ${this._page >= totalPages ? 'disabled' : ''} data-page="${this._page + 1}">Next ›</button>
          </div>
        ` : ''}
      </div>
    `;

    this.bindEvents(jobs, bookMap);
  },

  bindEvents(jobs, bookMap) {
    document.querySelectorAll('th[data-col]').forEach(th => {
      th.addEventListener('click', () => {
        const col = th.dataset.col;
        if (this._sort.col === col) this._sort.dir = this._sort.dir === 'asc' ? 'desc' : 'asc';
        else { this._sort.col = col; this._sort.dir = 'asc'; }
        this.render();
      });
    });

    ['filterStatus', 'filterModel'].forEach(id => {
      document.getElementById(id).addEventListener('change', (e) => {
        this._filters[id === 'filterStatus' ? 'status' : 'model'] = e.target.value;
        this._page = 1;
        this.render();
      });
    });
    ['filterMinQ', 'filterMaxQ'].forEach(id => {
      document.getElementById(id).addEventListener('change', (e) => {
        this._filters[id === 'filterMinQ' ? 'minQuality' : 'maxQuality'] = parseInt(e.target.value) || 0;
        this._page = 1;
        this.render();
      });
    });

    document.querySelectorAll('.page-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const p = parseInt(btn.dataset.page);
        if (p >= 1) { this._page = p; this.render(); }
      });
    });

    document.getElementById('exportCsv').addEventListener('click', () => {
      const rows = [['Book', 'Model', 'Variant', 'Status', 'Quality', 'Cost', 'Date']];
      jobs.forEach(j => {
        const book = bookMap.get(j.book_id);
        rows.push([
          book?.title || '', j.model, j.variant, j.status,
          Math.round((j.quality_score || 0) * 100) + '%',
          '$' + (j.cost_usd || 0).toFixed(3),
          j.created_at || ''
        ]);
      });
      const csv = rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
      const blob = new Blob([csv], { type: 'text/csv' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'alexandria-history.csv';
      a.click();
      Toast.success('CSV exported');
    });
  }
};