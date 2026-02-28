/**
 * analytics.js — Model analytics page
 */

const CHART_COLORS = ['#c5a55a', '#1a2744', '#2e7d4f', '#c94040', '#3b82f6', '#7c3aed', '#f59e0b', '#ec4899'];
let charts = {};

async function init() {
  await loadCostBadge();
  await loadAnalytics();
  setupEventListeners();
}

async function loadCostBadge() {
  try {
    const data = await API.get('/api/analytics/costs');
    const el = document.getElementById('cost-today');
    if (el) el.textContent = formatCost(data.today);
  } catch (e) {}
}

async function loadAnalytics() {
  try {
    const data = await API.get('/api/analytics/models/compare');
    if (!data.length) {
      document.getElementById('model-tbody').innerHTML =
        '<tr><td colspan="7" style="text-align:center; padding:30px; color:var(--text-muted);">No model data yet. Generate some covers first!</td></tr>';
      return;
    }
    renderTable(data);
    renderRecommendation(data);
    renderCharts(data);
  } catch (e) {
    toast('Failed to load analytics: ' + e.message, 'error');
  }
}

function renderTable(data) {
  const tbody = document.getElementById('model-tbody');
  tbody.innerHTML = data.map(m => {
    const successRate = m.total_jobs > 0 ? (m.completed / m.total_jobs * 100) : 0;
    const quality = m.avg_quality != null ? m.avg_quality : 0;
    return `
      <tr>
        <td><code style="font-size:0.8125rem;">${m.model}</code></td>
        <td>${m.total_jobs}</td>
        <td>
          <div class="quality-bar">
            <div class="quality-bar-track"><div class="quality-bar-fill" style="width:${successRate}%; background:${successRate > 80 ? 'var(--green)' : successRate > 50 ? 'var(--gold)' : 'var(--red)'};"></div></div>
            <span>${successRate.toFixed(0)}%</span>
          </div>
        </td>
        <td>
          <div class="quality-bar">
            <div class="quality-bar-track"><div class="quality-bar-fill" style="width:${quality * 100}%;"></div></div>
            <span>${quality > 0 ? formatScore(quality) : '—'}</span>
          </div>
        </td>
        <td>${m.avg_cost != null ? formatCost(m.avg_cost) : '—'}</td>
        <td>${m.avg_duration_ms != null ? formatDuration(m.avg_duration_ms) : '—'}</td>
        <td>${formatCost(m.total_cost)}</td>
      </tr>`;
  }).join('');
}

function renderRecommendation(data) {
  const banner = document.getElementById('recommendation-banner');
  const text = document.getElementById('recommendation-text');

  // Pick best by quality * success_rate
  const scored = data.filter(m => m.completed > 0).map(m => ({
    ...m,
    score: (m.avg_quality || 0) * (m.completed / m.total_jobs),
  })).sort((a, b) => b.score - a.score);

  if (scored.length > 0) {
    const best = scored[0];
    text.textContent = `${best.model} has the best quality-to-reliability ratio (avg quality: ${best.avg_quality ? formatScore(best.avg_quality) : '—'}, success rate: ${(best.completed / best.total_jobs * 100).toFixed(0)}%)`;
    banner.classList.remove('hidden');
  }
}

function renderCharts(data) {
  const labels = data.map(m => m.model);

  // Quality by model
  renderBarChart('chart-quality-model', labels,
    data.map(m => m.avg_quality ? +(m.avg_quality * 100).toFixed(1) : 0),
    'Avg Quality (%)', '#c5a55a');

  // Speed by model
  renderBarChart('chart-speed-model', labels,
    data.map(m => m.avg_duration_ms ? +(m.avg_duration_ms / 1000).toFixed(1) : 0),
    'Avg Speed (s)', '#1a2744');

  // Cost by model
  renderBarChart('chart-cost-model', labels,
    data.map(m => m.avg_cost || 0),
    'Avg Cost ($)', '#2e7d4f');

  // Success rate
  renderBarChart('chart-success-model', labels,
    data.map(m => m.total_jobs > 0 ? +(m.completed / m.total_jobs * 100).toFixed(1) : 0),
    'Success Rate (%)', '#3b82f6');
}

function renderBarChart(canvasId, labels, values, label, color) {
  const ctx = document.getElementById(canvasId).getContext('2d');
  if (charts[canvasId]) charts[canvasId].destroy();
  charts[canvasId] = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label,
        data: values,
        backgroundColor: color,
        borderRadius: 3,
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { display: false }, ticks: { font: { size: 10 }, maxRotation: 20 } },
        y: { beginAtZero: true, ticks: { font: { size: 11 } } }
      }
    }
  });
}

function setupEventListeners() {
  document.getElementById('refresh-btn').addEventListener('click', async () => {
    await loadAnalytics();
    toast('Analytics refreshed', 'success');
  });
}

document.addEventListener('DOMContentLoaded', init);
