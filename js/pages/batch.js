// batch.js — Batch generation page
window.Pages = window.Pages || {};
window.Pages.batch = {
  _selectedBooks: new Set(),
  _batchId: null,

  async render() {
    const content = document.getElementById('content');
    const books = await DB.dbGetAll('books');
    const batches = await DB.dbGetAll('batches');

    content.innerHTML = `
      <div class="card">
        <div class="card-header">
          <span class="card-title">Batch Generation</span>
          <span class="text-sm text-muted">${this._selectedBooks.size} selected</span>
        </div>

        <div class="form-row mb-16">
          <div class="form-group">
            <label class="form-label">Model</label>
            <select class="form-select" id="batchModel">
              ${OpenRouter.MODELS.map(m => 
                `<option value="${m.id}">${m.label} ($${m.cost})</option>`
              ).join('')}
            </select>
          </div>
          <div class="form-group">
            <label class="form-label">Variants per book</label>
            <select class="form-select" id="batchVariants">
              ${[1,2,3,4,5].map(n => `<option value="${n}">${n}</option>`).join('')}
            </select>
          </div>
        </div>

        <div class="flex gap-8 mb-16">
          <button class="btn btn-primary" id="runBatchBtn">Run Batch</button>
          <button class="btn btn-secondary" id="selectAllBtn">Select All</button>
          <button class="btn btn-secondary" id="selectNoneBtn">Deselect All</button>
        </div>

        <div id="batchProgress" style="display:none" class="mb-16">
          <div class="flex justify-between items-center mb-8">
            <span class="fw-600" id="batchProgressLabel">0 / 0</span>
            <div class="batch-controls">
              <button class="btn btn-sm btn-secondary" id="pauseBatchBtn">Pause</button>
              <button class="btn btn-sm btn-danger" id="cancelBatchBtn">Cancel</button>
            </div>
          </div>
          <div class="progress-bar">
            <div class="progress-fill" id="batchProgressFill" style="width:0%"></div>
          </div>
        </div>

        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th style="width:40px"><input type="checkbox" id="checkAll"></th>
                <th>#</th>
                <th>Title</th>
                <th>Author</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody id="bookTableBody">
              ${books.sort((a,b) => (a.number||'').localeCompare(b.number||'',undefined,{numeric:true})).map(book => `
                <tr data-book-id="${book.id}">
                  <td><input type="checkbox" class="book-check" value="${book.id}" ${this._selectedBooks.has(book.id) ? 'checked' : ''}></td>
                  <td>${book.number || '—'}</td>
                  <td>${book.title}</td>
                  <td>${book.author || '—'}</td>
                  <td><span class="tag tag-queued">Ready</span></td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>

      ${batches.length > 0 ? `
        <div class="card mt-16">
          <div class="card-title mb-16">Recent Batches</div>
          <div class="table-wrap">
            <table>
              <thead><tr><th>Batch</th><th>Books</th><th>Model</th><th>Status</th><th>Created</th></tr></thead>
              <tbody>
                ${batches.sort((a,b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, 10).map(b => `
                  <tr>
                    <td>${b.name || b.id.slice(0, 8)}</td>
                    <td>${(b.book_ids || []).length}</td>
                    <td><span class="tag tag-model">${OpenRouter.MODEL_LABELS[b.model] || b.model}</span></td>
                    <td><span class="tag ${b.status === 'completed' ? 'tag-status' : 'tag-pending'}">${b.status}</span></td>
                    <td>${formatDate(b.created_at)}</td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        </div>
      ` : ''}
    `;

    this.bindEvents(books);
  },

  bindEvents(books) {
    document.querySelectorAll('.book-check').forEach(cb => {
      cb.addEventListener('change', () => {
        if (cb.checked) this._selectedBooks.add(cb.value);
        else this._selectedBooks.delete(cb.value);
        document.querySelector('.card-header .text-sm').textContent = `${this._selectedBooks.size} selected`;
      });
    });

    document.getElementById('checkAll').addEventListener('change', (e) => {
      document.querySelectorAll('.book-check').forEach(cb => {
        cb.checked = e.target.checked;
        if (e.target.checked) this._selectedBooks.add(cb.value);
        else this._selectedBooks.delete(cb.value);
      });
      document.querySelector('.card-header .text-sm').textContent = `${this._selectedBooks.size} selected`;
    });

    document.getElementById('selectAllBtn').addEventListener('click', () => {
      books.forEach(b => this._selectedBooks.add(b.id));
      document.querySelectorAll('.book-check').forEach(cb => cb.checked = true);
      document.querySelector('.card-header .text-sm').textContent = `${this._selectedBooks.size} selected`;
    });

    document.getElementById('selectNoneBtn').addEventListener('click', () => {
      this._selectedBooks.clear();
      document.querySelectorAll('.book-check').forEach(cb => cb.checked = false);
      document.querySelector('.card-header .text-sm').textContent = `0 selected`;
    });

    document.getElementById('runBatchBtn').addEventListener('click', () => this.runBatch(books));

    document.getElementById('pauseBatchBtn').addEventListener('click', () => {
      if (JobQueue.paused) {
        JobQueue.resume();
        document.getElementById('pauseBatchBtn').textContent = 'Pause';
      } else {
        JobQueue.pause();
        document.getElementById('pauseBatchBtn').textContent = 'Resume';
      }
    });

    document.getElementById('cancelBatchBtn').addEventListener('click', () => {
      JobQueue.cancelAll();
      Toast.warning('Batch cancelled');
      document.getElementById('batchProgress').style.display = 'none';
    });
  },

  async runBatch(books) {
    if (this._selectedBooks.size === 0) { Toast.warning('Select some books first'); return; }

    const model = document.getElementById('batchModel').value;
    const variants = parseInt(document.getElementById('batchVariants').value);
    const batchId = uuid();

    const batch = {
      id: batchId,
      name: `Batch ${new Date().toLocaleString()}`,
      book_ids: [...this._selectedBooks],
      model,
      variant_count: variants,
      status: 'running',
      completed_books: [],
      failed_books: [],
      created_at: new Date().toISOString()
    };
    await DB.dbPut('batches', batch);

    const allJobs = [];
    for (const bookId of this._selectedBooks) {
      const book = books.find(b => b.id === bookId);
      if (!book) continue;

      const prompt = `Create a beautiful, detailed illustration for the classic book "${book.title}"${book.author ? ` by ${book.author}` : ''}. The illustration should be a circular medallion-style vignette suitable for a book cover. Use a classic, timeless artistic style with rich detail.`;

      for (let v = 0; v < variants; v++) {
        const job = {
          id: uuid(),
          book_id: bookId,
          model: model,
          variant: v + 1,
          status: 'queued',
          prompt,
          quality_score: null,
          cost_usd: 0,
          generated_image_blob: null,
          composited_image_blob: null,
          started_at: null,
          completed_at: null,
          error: null,
          results_json: null,
          created_at: new Date().toISOString()
        };
        await DB.dbPut('jobs', job);
        allJobs.push(job);
      }
    }

    document.getElementById('batchProgress').style.display = 'block';
    const total = allJobs.length;
    let completed = 0;

    const updateProgress = async () => {
      const current = await DB.dbGetAll('jobs');
      completed = current.filter(j => allJobs.some(aj => aj.id === j.id) && (j.status === 'completed' || j.status === 'failed')).length;
      const pct = total > 0 ? (completed / total * 100) : 0;
      const label = document.getElementById('batchProgressLabel');
      const fill = document.getElementById('batchProgressFill');
      if (label) label.textContent = `${completed} / ${total}`;
      if (fill) fill.style.width = `${pct}%`;

      if (completed >= total) {
        batch.status = 'completed';
        await DB.dbPut('batches', batch);
        Toast.success(`Batch complete: ${completed} images generated`);
      }
    };

    JobQueue.onChange(updateProgress);
    JobQueue.addBatch(allJobs);
    Toast.info(`Started batch: ${allJobs.length} jobs queued`);
  }
};