// analytics.js — Cost timeline, model comparison charts
window.Pages = window.Pages || {};
window.Pages.analytics = {
  _charts: [],

  async render() {
    const content = document.getElementById('content');
    
    this._charts.forEach(c => c.destroy());
    this._charts = [];

    const ledger = await DB.dbGetAll('cost_ledger');
    const jobs = await DB.dbGetAll('jobs');
    const completedJobs = jobs.filter(j => j.status === 'completed');

    content.innerHTML = `
      <div class="grid-2 mb-24">
        <div class="card">
          <div class="card-title mb-16">Cost Timeline (Last 30 Days)</div>
          <div class="chart-container"><canvas id="costTimelineChart"></canvas></div>
        </div>
        <div class="card">
          <div class="card-title mb-16">Cost by Model</div>
          <div class="chart-container"><canvas id="costModelChart"></canvas></div>
        </div>
      </div>
      <div class="grid-2 mb-24">
        <div class="card">
          <div class="card-title mb-16">Quality Distribution</div>
          <div class="chart-container"><canvas id="qualityHistChart"></canvas></div>
        </div>
        <div class="card">
          <div class="card-title mb-16">Generations Over Time</div>
          <div class="chart-container"><canvas id="genTimelineChart"></canvas></div>
        </div>
      </div>
      <div class="card">
        <div class="card-title mb-16">Model Comparison</div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr><th>Model</th><th>Total Jobs</th><th>Completed</th><th>Failed</th><th>Avg Quality</th><th>Avg Cost</th><th>Total Cost</th></tr>
            </thead>
            <tbody id="modelCompTable"></tbody>
          </table>
        </div>
      </div>
    `;

    this.renderCharts(ledger, completedJobs, jobs);
    this.renderModelTable(jobs);
  },

  renderCharts(ledger, completedJobs, allJobs) {
    const colors = {
      gold: '#c5a55a', navy: '#1a2744', green: '#22c55e',
      red: '#ef4444', blue: '#3b82f6', purple: '#8b5cf6',
      orange: '#f97316', pink: '#ec4899'
    };

    const now = new Date();
    const days = [];
    const dayCosts = [];
    for (let i = 29; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      const key = d.toISOString().slice(0, 10);
      days.push(d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }));
      const dayCost = ledger
        .filter(e => e.recorded_at && e.recorded_at.slice(0, 10) === key)
        .reduce((sum, e) => sum + (e.cost_usd || 0), 0);
      dayCosts.push(Math.round(dayCost * 1000) / 1000);
    }

    const ctx1 = document.getElementById('costTimelineChart')?.getContext('2d');
    if (ctx1) {
      this._charts.push(new Chart(ctx1, {
        type: 'bar',
        data: { labels: days, datasets: [{ label: 'Daily Cost ($)', data: dayCosts, backgroundColor: colors.gold, borderRadius: 4 }] },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { display: true, grid: { display: false } }, y: { beginAtZero: true, ticks: { callback: v => '$' + v } } } }
      }));
    }

    const modelCosts = {};
    ledger.forEach(e => {
      const label = OpenRouter.MODEL_LABELS[e.model] || e.model;
      modelCosts[label] = (modelCosts[label] || 0) + (e.cost_usd || 0);
    });

    const ctx2 = document.getElementById('costModelChart')?.getContext('2d');
    if (ctx2) {
      this._charts.push(new Chart(ctx2, {
        type: 'doughnut',
        data: { labels: Object.keys(modelCosts), datasets: [{ data: Object.values(modelCosts).map(v => Math.round(v * 1000) / 1000), backgroundColor: [colors.gold, colors.blue, colors.purple, colors.orange] }] },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom' } } }
      }));
    }

    const bins = Array(10).fill(0);
    completedJobs.forEach(j => {
      const q = Math.min(Math.floor((j.quality_score || 0) * 10), 9);
      bins[q]++;
    });

    const ctx3 = document.getElementById('qualityHistChart')?.getContext('2d');
    if (ctx3) {
      this._charts.push(new Chart(ctx3, {
        type: 'bar',
        data: { labels: ['0-10%', '10-20%', '20-30%', '30-40%', '40-50%', '50-60%', '60-70%', '70-80%', '80-90%', '90-100%'], datasets: [{ label: 'Images', data: bins, backgroundColor: colors.navy, borderRadius: 4 }] },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { grid: { display: false } }, y: { beginAtZero: true } } }
      }));
    }

    const genDays = [];
    const genCounts = [];
    for (let i = 29; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      const key = d.toISOString().slice(0, 10);
      genDays.push(d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }));
      genCounts.push(allJobs.filter(j => j.created_at && j.created_at.slice(0, 10) === key).length);
    }

    const ctx4 = document.getElementById('genTimelineChart')?.getContext('2d');
    if (ctx4) {
      this._charts.push(new Chart(ctx4, {
        type: 'line',
        data: { labels: genDays, datasets: [{ label: 'Generations', data: genCounts, borderColor: colors.gold, backgroundColor: 'rgba(197,165,90,0.1)', fill: true, tension: 0.3, pointRadius: 2 }] },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { display: true, grid: { display: false } }, y: { beginAtZero: true } } }
      }));
    }
  },

  async renderModelTable(jobs) {
    const tbody = document.getElementById('modelCompTable');
    if (!tbody) return;

    const models = {};
    jobs.forEach(j => {
      if (!models[j.model]) models[j.model] = { total: 0, completed: 0, failed: 0, qualitySum: 0, costSum: 0 };
      models[j.model].total++;
      if (j.status === 'completed') {
        models[j.model].completed++;
        models[j.model].qualitySum += j.quality_score || 0;
        models[j.model].costSum += j.cost_usd || 0;
      }
      if (j.status === 'failed') models[j.model].failed++;
    });

    tbody.innerHTML = Object.entries(models).map(([m, s]) => `
      <tr>
        <td><span class="tag tag-model">${OpenRouter.MODEL_LABELS[m] || m}</span></td>
        <td>${s.total}</td>
        <td>${s.completed}</td>
        <td>${s.failed}</td>
        <td>${s.completed > 0 ? Math.round(s.qualitySum / s.completed * 100) + '%' : '—'}</td>
        <td>${s.completed > 0 ? '$' + (s.costSum / s.completed).toFixed(3) : '—'}</td>
        <td>$${s.costSum.toFixed(3)}</td>
      </tr>
    `).join('') || '<tr><td colspan="7" class="text-muted" style="text-align:center">No data yet</td></tr>';
  }
};