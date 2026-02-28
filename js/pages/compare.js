// compare.js — Side-by-side comparison of book variants
window.Pages = window.Pages || {};
window.Pages.compare = {
  _selectedBooks: [],

  async render() {
    const content = document.getElementById('content');
    const books = await DB.dbGetAll('books');
    const jobs = await DB.dbGetAll('jobs');
    const completedJobs = jobs.filter(j => j.status === 'completed');

    const booksWithVariants = books.filter(b => completedJobs.some(j => j.book_id === b.id));

    content.innerHTML = `
      <div class="card mb-16">
        <div class="card-title mb-16">Compare Books Side-by-Side</div>
        <p class="text-sm text-muted mb-16">Select 2-4 books to compare their generated variants</p>
        <div class="form-group">
          <label class="form-label">Select books to compare</label>
          <div style="display:flex;flex-wrap:wrap;gap:8px" id="compareBookPicker">
            ${booksWithVariants.map(b => `
              <button class="filter-chip ${this._selectedBooks.includes(b.id) ? 'active' : ''}" data-book-id="${b.id}">
                ${b.number ? b.number + ' — ' : ''}${b.title}
              </button>
            `).join('')}
            ${booksWithVariants.length === 0 ? '<span class="text-sm text-muted">No books with variants yet. Generate some first.</span>' : ''}
          </div>
        </div>
      </div>

      <div id="compareContent">
        ${this._selectedBooks.length === 0 ? `
          <div class="empty-state">
            <h3>Select books to compare</h3>
            <p>Click on book names above to add them to the comparison</p>
          </div>
        ` : ''}
      </div>
    `;

    document.querySelectorAll('#compareBookPicker .filter-chip').forEach(btn => {
      btn.addEventListener('click', () => {
        const bookId = btn.dataset.bookId;
        const idx = this._selectedBooks.indexOf(bookId);
        if (idx >= 0) {
          this._selectedBooks.splice(idx, 1);
        } else if (this._selectedBooks.length < 4) {
          this._selectedBooks.push(bookId);
        } else {
          Toast.warning('Maximum 4 books for comparison');
          return;
        }
        this.render();
      });
    });

    if (this._selectedBooks.length >= 2) {
      await this.renderComparison(books, completedJobs);
    }
  },

  async renderComparison(books, jobs) {
    const container = document.getElementById('compareContent');
    const bookMap = new Map(books.map(b => [b.id, b]));
    const cols = this._selectedBooks.length;

    let html = `<div class="compare-grid" style="grid-template-columns:repeat(${cols}, 1fr)">`;

    for (const bookId of this._selectedBooks) {
      const book = bookMap.get(bookId);
      const bookJobs = jobs.filter(j => j.book_id === bookId).sort((a, b) => (b.quality_score || 0) - (a.quality_score || 0));

      html += `
        <div class="card">
          <div class="card-title mb-16">${book?.title || 'Unknown'}</div>
          <div class="text-sm text-muted mb-16">${book?.author || ''} — ${bookJobs.length} variants</div>
          ${bookJobs.map(j => {
            const thumbSrc = j.generated_image_blob ? getBlobUrl(j.generated_image_blob, `gen-${j.id}`) : '';
            const q = j.quality_score || 0;
            const qClass = q >= 0.7 ? 'high' : q >= 0.4 ? 'medium' : 'low';
            const elapsed = j.started_at && j.completed_at 
              ? Math.round((new Date(j.completed_at) - new Date(j.started_at)) / 1000) + 's'
              : '—';
            return `
              <div style="margin-bottom:12px;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden">
                ${thumbSrc ? `<img src="${thumbSrc}" style="width:100%;aspect-ratio:1;object-fit:cover" loading="lazy">` : '<div style="width:100%;height:120px;background:#f1f5f9;display:flex;align-items:center;justify-content:center;color:#94a3b8">No image</div>'}
                <div style="padding:8px">
                  <span class="tag tag-model">${OpenRouter.MODEL_LABELS[j.model] || j.model}</span>
                  <div class="quality-meter mt-8">
                    <div class="quality-bar"><div class="quality-fill ${qClass}" style="width:${q*100}%"></div></div>
                    <span class="text-xs">${Math.round(q*100)}%</span>
                  </div>
                  <div class="flex justify-between text-xs text-muted mt-8">
                    <span>$${(j.cost_usd||0).toFixed(3)}</span>
                    <span>${elapsed}</span>
                  </div>
                </div>
              </div>
            `;
          }).join('')}
          ${bookJobs.length === 0 ? '<p class="text-sm text-muted">No variants</p>' : ''}
        </div>
      `;
    }

    html += '</div>';
    container.innerHTML = html;
  }
};