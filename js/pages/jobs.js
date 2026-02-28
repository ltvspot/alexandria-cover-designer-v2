// jobs.js — Live job queue view
window.Pages = window.Pages || {};
window.Pages.jobs = {
  _refreshInterval: null,

  async render() {
    const content = document.getElementById('content');

    if (this._refreshInterval) {
      clearInterval(this._refreshInterval);
      this._refreshInterval = null;
    }

    const renderInner = async () => {
      const activeJobs = await DB.dbGetAll('jobs');
      const books = await DB.dbGetAll('books');
      const bookMap = new Map(books.map(b => [b.id, b]));

      const queuedJobs = activeJobs.filter(j => j.status === 'queued');
      const runningJobs = activeJobs.filter(j => ['downloading_cover', 'generating', 'compositing', 'scoring'].includes(j.status));
      const recentDone = activeJobs.filter(j => j.status === 'completed' || j.status === 'failed')
        .sort((a, b) => new Date(b.completed_at || b.created_at) - new Date(a.completed_at || a.created_at))
        .slice(0, 20);

      const current = JobQueue.currentJob;
      const queueLen = JobQueue.queue.length;

      content.innerHTML = `
        <div class="kpi-grid" style="grid-template-columns:repeat(4,1fr)">
          <div class="kpi-card">
            <div class="kpi-label">Queue</div>
            <div class="kpi-value">${queueLen}</div>
          </div>
          <div class="kpi-card">
            <div class="kpi-label">Running</div>
            <div class="kpi-value">${current ? '1' : '0'}</div>
          </div>
          <div class="kpi-card">
            <div class="kpi-label">Completed</div>
            <div class="kpi-value">${activeJobs.filter(j => j.status === 'completed').length}</div>
          </div>
          <div class="kpi-card">
            <div class="kpi-label">Failed</div>
            <div class="kpi-value">${activeJobs.filter(j => j.status === 'failed').length}</div>
          </div>
        </div>

        <div class="flex gap-8 mb-16">
          <button class="btn btn-secondary btn-sm" id="pauseQueue">${JobQueue.paused ? 'Resume Queue' : 'Pause Queue'}</button>
          <button class="btn btn-danger btn-sm" id="clearQueue">Clear Queue</button>
          <span class="text-sm text-muted" style="line-height:30px">${JobQueue.paused ? '⏸ Paused' : JobQueue.running ? '▶ Running' : '● Idle'}</span>
        </div>

        ${queueLen > 0 ? `
          <div class="card mb-16">
            <div class="card-title mb-16">Queued Jobs (${queueLen})</div>
            <div class="table-wrap">
              <table>
                <thead><tr><th>Book</th><th>Model</th><th>Variant</th><th>Action</th></tr></thead>
                <tbody>
                  ${JobQueue.queue.slice(0, 20).map(j => `
                    <tr>
                      <td>${bookMap.get(j.book_id)?.title || j.book_id?.slice(0,8)}</td>
                      <td><span class="tag tag-model">${OpenRouter.MODEL_LABELS[j.model] || j.model}</span></td>
                      <td>${j.variant || 1}</td>
                      <td><button class="btn btn-sm btn-danger cancel-job" data-id="${j.id}">Cancel</button></td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            </div>
          </div>
        ` : ''}

        <div class="card">
          <div class="card-title mb-16">Recent Completed/Failed</div>
          <div class="table-wrap">
            <table>
              <thead><tr><th>Book</th><th>Model</th><th>Status</th><th>Quality</th><th>Time</th><th>Action</th></tr></thead>
              <tbody>
                ${recentDone.length === 0 ? '<tr><td colspan="6" class="text-muted" style="text-align:center">No completed jobs yet</td></tr>' : ''}
                ${recentDone.map(j => {
                  const book = bookMap.get(j.book_id);
                  return `
                    <tr>
                      <td>${book?.title || '—'}</td>
                      <td><span class="tag tag-model">${OpenRouter.MODEL_LABELS[j.model] || j.model}</span></td>
                      <td><span class="tag ${j.status === 'completed' ? 'tag-status' : 'tag-failed'}">${j.status}</span></td>
                      <td>${j.quality_score ? Math.round(j.quality_score * 100) + '%' : '—'}</td>
                      <td>${timeAgo(j.completed_at)}</td>
                      <td>${j.status === 'failed' ? `<button class="btn btn-sm btn-secondary retry-job" data-id="${j.id}">Retry</button>` : ''}</td>
                    </tr>
                  `;
                }).join('')}
              </tbody>
            </table>
          </div>
        </div>
      `;

      document.getElementById('pauseQueue')?.addEventListener('click', () => {
        if (JobQueue.paused) JobQueue.resume(); else JobQueue.pause();
        renderInner();
      });
      document.getElementById('clearQueue')?.addEventListener('click', () => {
        JobQueue.cancelAll();
        Toast.info('Queue cleared');
        renderInner();
      });
      document.querySelectorAll('.cancel-job').forEach(btn => {
        btn.addEventListener('click', () => {
          JobQueue.cancel(btn.dataset.id);
          renderInner();
        });
      });
      document.querySelectorAll('.retry-job').forEach(btn => {
        btn.addEventListener('click', async () => {
          const job = await DB.dbGet('jobs', btn.dataset.id);
          if (job) {
            job.status = 'queued';
            job.error = null;
            job.started_at = null;
            job.completed_at = null;
            await DB.dbPut('jobs', job);
            JobQueue.add(job);
            Toast.info('Job re-queued');
            renderInner();
          }
        });
      });
    };

    await renderInner();

    this._refreshInterval = setInterval(renderInner, 3000);

    const cleanup = () => {
      if (this._refreshInterval) {
        clearInterval(this._refreshInterval);
        this._refreshInterval = null;
      }
      window.removeEventListener('hashchange', cleanup);
    };
    window.addEventListener('hashchange', cleanup);
  }
};