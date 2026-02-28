// mockups.js — View composited covers at different sizes
window.Pages = window.Pages || {};
window.Pages.mockups = {
  async render() {
    const content = document.getElementById('content');
    const jobs = (await DB.dbGetAll('jobs')).filter(j => j.status === 'completed');
    const books = await DB.dbGetAll('books');
    const winners = await DB.dbGetAll('winners');
    const bookMap = new Map(books.map(b => [b.id, b]));

    const booksWithComposites = [];
    for (const w of winners) {
      const job = jobs.find(j => j.id === w.job_id);
      if (job && (job.composited_image_blob || job.generated_image_blob)) {
        booksWithComposites.push({ book: bookMap.get(w.book_id), job, winner: w });
      }
    }
    for (const j of jobs.slice(-10)) {
      if (!booksWithComposites.find(b => b.job.id === j.id) && (j.composited_image_blob || j.generated_image_blob)) {
        booksWithComposites.push({ book: bookMap.get(j.book_id), job: j, winner: null });
      }
    }

    content.innerHTML = `
      <div class="card mb-16">
        <div class="card-title mb-16">Cover Mockups</div>
        <p class="text-sm text-muted mb-16">Preview composited covers at different sizes to see how the medallion looks</p>
        <div class="form-group">
          <label class="form-label">Select a cover</label>
          <select class="form-select" id="mockupSelect" style="max-width:400px">
            <option value="">— Choose a book —</option>
            ${booksWithComposites.map((b, i) => 
              `<option value="${i}">${b.book?.title || 'Unknown'} (${OpenRouter.MODEL_LABELS[b.job.model] || b.job.model})</option>`
            ).join('')}
          </select>
          ${booksWithComposites.length === 0 ? '<span class="form-hint">No composited covers yet. Generate illustrations first.</span>' : ''}
        </div>
      </div>

      <div id="mockupPreview"></div>
    `;

    document.getElementById('mockupSelect').addEventListener('change', (e) => {
      const idx = parseInt(e.target.value);
      if (isNaN(idx)) {
        document.getElementById('mockupPreview').innerHTML = '';
        return;
      }
      this.showMockup(booksWithComposites[idx]);
    });
  },

  showMockup(item) {
    const container = document.getElementById('mockupPreview');
    const blob = item.job.composited_image_blob || item.job.generated_image_blob;
    if (!blob) {
      container.innerHTML = '<p class="text-sm text-muted">No image available</p>';
      return;
    }

    const imgUrl = getBlobUrl(blob, `mockup-${item.job.id}`);
    const title = item.book?.title || 'Unknown';

    container.innerHTML = `
      <div class="grid-3">
        <div class="card" style="text-align:center">
          <div class="card-title mb-16">Thumbnail (200px)</div>
          <img src="${imgUrl}" style="width:200px;max-width:100%;border-radius:4px;border:1px solid #e2e8f0" loading="lazy">
          <p class="text-sm text-muted mt-8">Web listing / catalog view</p>
        </div>

        <div class="card" style="text-align:center">
          <div class="card-title mb-16">Print Preview (400px)</div>
          <img src="${imgUrl}" style="width:400px;max-width:100%;border-radius:4px;border:1px solid #e2e8f0" loading="lazy">
          <p class="text-sm text-muted mt-8">Print-ready preview</p>
        </div>

        <div class="card" style="text-align:center">
          <div class="card-title mb-16">Full Size</div>
          <div style="max-height:500px;overflow:auto;border:1px solid #e2e8f0;border-radius:4px">
            <img src="${imgUrl}" style="width:100%" loading="lazy">
          </div>
          <p class="text-sm text-muted mt-8">3784×2777px wraparound cover</p>
        </div>
      </div>

      <div class="card mt-16">
        <div class="card-title mb-16">Cover Details</div>
        <div class="grid-2">
          <div>
            <div class="form-group"><span class="form-label">Title</span><p>${title}</p></div>
            <div class="form-group"><span class="form-label">Author</span><p>${item.book?.author || '—'}</p></div>
            <div class="form-group"><span class="form-label">Model</span><p>${OpenRouter.MODEL_LABELS[item.job.model] || item.job.model}</p></div>
          </div>
          <div>
            <div class="form-group"><span class="form-label">Quality</span><p>${Math.round((item.job.quality_score || 0) * 100)}%</p></div>
            <div class="form-group"><span class="form-label">Cost</span><p>$${(item.job.cost_usd || 0).toFixed(3)}</p></div>
            <div class="form-group"><span class="form-label">Generated</span><p>${formatDate(item.job.completed_at)}</p></div>
          </div>
        </div>
        <button class="btn btn-primary btn-sm mt-16" onclick="Pages.mockups.download('${item.job.id}')">Download Full Size</button>
      </div>
    `;
  },

  async download(jobId) {
    const job = await DB.dbGet('jobs', jobId);
    if (!job) return;
    const imgData = job.composited_image_blob || job.generated_image_blob;
    if (!imgData) { Toast.warning('No image available'); return; }
    const book = await DB.dbGet('books', job.book_id);
    const url = typeof imgData === 'string' ? imgData : URL.createObjectURL(imgData);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${book?.title || 'cover'}_mockup.jpg`;
    a.click();
    if (typeof imgData !== 'string') {
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  }
};