// similarity.js — Flag potentially similar/duplicate illustrations
window.Pages = window.Pages || {};
window.Pages.similarity = {
  async render() {
    const content = document.getElementById('content');
    const jobs = (await DB.dbGetAll('jobs')).filter(j => j.status === 'completed' && j.generated_image_blob);
    const books = await DB.dbGetAll('books');
    const bookMap = new Map(books.map(b => [b.id, b]));

    if (jobs.length < 2) {
      content.innerHTML = `
        <div class="empty-state">
          <h3>Not enough images</h3>
          <p>Generate at least 2 illustrations to check for similarities</p>
        </div>
      `;
      return;
    }

    content.innerHTML = `
      <div class="card mb-16">
        <div class="card-title mb-16">Similarity Check</div>
        <p class="text-sm text-muted mb-16">
          Comparing color histograms of generated illustrations to flag potential duplicates.
          Pairs with high similarity scores may look too alike.
        </p>
        <button class="btn btn-primary btn-sm" id="runSimilarityCheck">Run Check</button>
        <span class="text-sm text-muted" id="simStatus" style="margin-left:12px"></span>
      </div>
      <div id="simResults"></div>
    `;

    document.getElementById('runSimilarityCheck').addEventListener('click', () => {
      this.runCheck(jobs, bookMap);
    });
  },

  async runCheck(jobs, bookMap) {
    const status = document.getElementById('simStatus');
    const results = document.getElementById('simResults');
    status.textContent = 'Analyzing images...';

    const fingerprints = [];
    for (const job of jobs.slice(0, 50)) {
      try {
        const img = await OpenRouter.loadImage(job.generated_image_blob);
        const fp = this.getFingerprint(img);
        fingerprints.push({ job, fp });
      } catch (e) {}
    }

    const pairs = [];
    for (let i = 0; i < fingerprints.length; i++) {
      for (let j = i + 1; j < fingerprints.length; j++) {
        const similarity = this.compareFP(fingerprints[i].fp, fingerprints[j].fp);
        if (similarity > 0.85) {
          pairs.push({ job1: fingerprints[i].job, job2: fingerprints[j].job, similarity });
        }
      }
    }

    pairs.sort((a, b) => b.similarity - a.similarity);

    status.textContent = `Checked ${fingerprints.length} images, found ${pairs.length} similar pairs`;

    if (pairs.length === 0) {
      results.innerHTML = `
        <div class="empty-state">
          <h3>No duplicates found</h3>
          <p>All generated illustrations appear sufficiently unique</p>
        </div>
      `;
      return;
    }

    results.innerHTML = pairs.map(p => {
      const book1 = bookMap.get(p.job1.book_id);
      const book2 = bookMap.get(p.job2.book_id);
      const thumb1 = getBlobUrl(p.job1.generated_image_blob, `gen-${p.job1.id}`);
      const thumb2 = getBlobUrl(p.job2.generated_image_blob, `gen-${p.job2.id}`);

      return `
        <div class="card mb-16" style="border-color:${p.similarity > 0.95 ? '#ef4444' : '#eab308'}">
          <div class="flex justify-between items-center mb-16">
            <span class="card-title">Similarity: ${Math.round(p.similarity * 100)}%</span>
            <span class="tag ${p.similarity > 0.95 ? 'tag-failed' : 'tag-pending'}">
              ${p.similarity > 0.95 ? 'Very Similar' : 'Similar'}
            </span>
          </div>
          <div class="grid-2">
            <div style="text-align:center">
              ${thumb1 ? `<img src="${thumb1}" style="width:100%;max-width:250px;border-radius:8px" loading="lazy">` : ''}
              <div class="text-sm mt-8">${book1?.title || 'Unknown'}</div>
              <div class="text-xs text-muted">${OpenRouter.MODEL_LABELS[p.job1.model] || p.job1.model}</div>
            </div>
            <div style="text-align:center">
              ${thumb2 ? `<img src="${thumb2}" style="width:100%;max-width:250px;border-radius:8px" loading="lazy">` : ''}
              <div class="text-sm mt-8">${book2?.title || 'Unknown'}</div>
              <div class="text-xs text-muted">${OpenRouter.MODEL_LABELS[p.job2.model] || p.job2.model}</div>
            </div>
          </div>
        </div>
      `;
    }).join('');
  },

  getFingerprint(img) {
    const canvas = document.createElement('canvas');
    canvas.width = 32;
    canvas.height = 32;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, 32, 32);
    const data = ctx.getImageData(0, 0, 32, 32).data;

    const hist = new Float32Array(48);
    for (let i = 0; i < data.length; i += 4) {
      hist[Math.floor(data[i] / 16)] += 1;
      hist[16 + Math.floor(data[i + 1] / 16)] += 1;
      hist[32 + Math.floor(data[i + 2] / 16)] += 1;
    }

    const total = 32 * 32;
    for (let i = 0; i < hist.length; i++) hist[i] /= total;
    return hist;
  },

  compareFP(fp1, fp2) {
    let dot = 0, mag1 = 0, mag2 = 0;
    for (let i = 0; i < fp1.length; i++) {
      dot += fp1[i] * fp2[i];
      mag1 += fp1[i] ** 2;
      mag2 += fp2[i] ** 2;
    }
    return dot / (Math.sqrt(mag1) * Math.sqrt(mag2) + 1e-8);
  }
};