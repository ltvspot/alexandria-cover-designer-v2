// dashboard.js — Dashboard with KPIs and activity feed
window.Pages = window.Pages || {};
window.Pages.dashboard = {
  async render() {
    const content = document.getElementById('content');
    const jobs = await DB.dbGetAll('jobs');
    const books = await DB.dbGetAll('books');
    const winners = await DB.dbGetAll('winners');
    const ledger = await DB.dbGetAll('cost_ledger');
    const budgetLimit = await DB.getSetting('budget_limit') || 50;

    const completedJobs = jobs.filter(j => j.status === 'completed');
    const totalSpent = ledger.reduce((sum, e) => sum + (e.cost_usd || 0), 0);
    const avgQuality = completedJobs.length > 0 
      ? completedJobs.reduce((sum, j) => sum + (j.quality_score || 0), 0) / completedJobs.length 
      : 0;
    const budgetPct = budgetLimit > 0 ? (totalSpent / budgetLimit * 100) : 0;

    const recentJobs = jobs
      .filter(j => j.status === 'completed' || j.status === 'failed')
      .sort((a, b) => new Date(b.completed_at || b.created_at) - new Date(a.completed_at || a.created_at))
      .slice(0, 10);
    
    const bookMap = new Map(books.map(b => [b.id, b]));

    const modelStats = {};
    completedJobs.forEach(j => {
      if (!modelStats[j.model]) modelStats[j.model] = { count: 0, cost: 0, quality: 0 };
      modelStats[j.model].count++;
      modelStats[j.model].cost += j.cost_usd || 0;
      modelStats[j.model].quality += j.quality_score || 0;
    });

    content.innerHTML = `
      <div class="kpi-grid">
        <div class="kpi-card">
          <div class="kpi-label">Total Spent</div>
          <div class="kpi-value">$${totalSpent.toFixed(2)}</div>
          <div class="kpi-sub">of $${budgetLimit} budget</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Books in Catalog</div>
          <div class="kpi-value">${books.length}</div>
          <div class="kpi-sub">${winners.length} approved</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Avg Quality</div>
          <div class="kpi-value">${Math.round(avgQuality * 100)}%</div>
          <div class="kpi-sub">${completedJobs.length} scored</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Total Images</div>
          <div class="kpi-value">${completedJobs.length}</div>
          <div class="kpi-sub">${jobs.filter(j => j.status === 'failed').length} failed</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Approved</div>
          <div class="kpi-value">${winners.length}</div>
          <div class="kpi-sub">${winners.filter(w => w.auto_approved).length} auto</div>
        </div>
      </div>

      <div class="grid-2">
        <div class="card">
          <div class="card-title mb-16">Budget</div>
          <div class="progress-bar" style="height:12px;margin-bottom:8px">
            <div class="progress-fill ${budgetPct > 90 ? 'danger' : ''}" style="width:${Math.min(budgetPct, 100)}%"></div>
          </div>
          <div class="flex justify-between text-sm text-muted">
            <span>$${totalSpent.toFixed(2)} used</span>
            <span>$${(budgetLimit - totalSpent).toFixed(2)} remaining</span>
          </div>

          <div style="margin-top:24px">
            <div class="card-title mb-16">Model Breakdown</div>
            <div class="table-wrap">
              <table>
                <thead><tr><th>Model</th><th>Jobs</th><th>Cost</th><th>Avg Quality</th></tr></thead>
                <tbody>
                  ${Object.entries(modelStats).map(([m, s]) => `
                    <tr>
                      <td><span class="tag tag-model">${OpenRouter.MODEL_LABELS[m] || m}</span></td>
                      <td>${s.count}</td>
                      <td>$${s.cost.toFixed(3)}</td>
                      <td>${Math.round(s.quality / s.count * 100)}%</td>
                    </tr>
                  `).join('') || '<tr><td colspan="4" class="text-muted" style="text-align:center">No data yet</td></tr>'}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <div class="card">
          <div class="card-title mb-16">Recent Activity</div>
          ${recentJobs.length === 0 ? '<p class="text-sm text-muted">No recent activity</p>' : ''}
          ${recentJobs.map(j => {
            const book = bookMap.get(j.book_id);
            const model = OpenRouter.MODEL_LABELS[j.model] || j.model;
            return `
              <div class="activity-item">
                <div class="activity-dot" style="background:${j.status === 'completed' ? '#22c55e' : '#ef4444'}"></div>
                <div style="flex:1">
                  <div class="activity-text">
                    ${j.status === 'completed' ? 'Generated' : 'Failed'} illustration for <strong>${book?.title || 'Unknown'}</strong> 
                    using ${model}
                    ${j.status === 'completed' ? ` — ${Math.round((j.quality_score||0)*100)}% quality` : ''}
                  </div>
                  <div class="activity-time">${timeAgo(j.completed_at || j.created_at)}</div>
                </div>
              </div>
            `;
          }).join('')}
        </div>
      </div>
    `;
  }
};