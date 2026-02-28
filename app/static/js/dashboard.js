/**
 * dashboard.js — Dashboard page with Chart.js charts
 */

const CHART_COLORS = {
  navy: '#1a2744',
  gold: '#c5a55a',
  green: '#2e7d4f',
  bronze: '#8a6f4e',
  red: '#c94040',
  blue: '#3b82f6',
  purple: '#7c3aed',
  models: ['#c5a55a', '#1a2744', '#2e7d4f', '#c94040', '#3b82f6', '#7c3aed', '#f59e0b'],
};

let charts = {};

async function init() {
  await loadKPIs();
  await loadModels();
  await loadTimelineChart();
  await loadModelChart();
  await loadQualityChart();
  setupProjector();
  setupEventListeners();
}

async function loadKPIs() {
  try {
    const data = await API.get('/api/analytics/dashboard');
    document.getElementById('cost-today').textContent = formatCost(data.today_spent);
    document.getElementById('kpi-total-spent').textContent = formatCost(data.total_spent);
    document.getElementById('kpi-today-spent').textContent = `Today: ${formatCost(data.today_spent)}`;
    document.getElementById('kpi-budget-remaining').textContent = formatCost(data.budget_remaining);
    document.getElementById('kpi-budget-limit').textContent = `Limit: ${formatCost(data.budget_limit)}`;
    document.getElementById('kpi-books-generated').textContent = data.books_generated;
    document.getElementById('kpi-total-books').textContent = `Total books: ${data.total_books}`;
    document.getElementById('kpi-avg-quality').textContent =
      data.avg_quality ? Math.round(data.avg_quality * 100) + '%' : '—';
    document.getElementById('kpi-total-images').textContent = data.total_images;
    document.getElementById('kpi-approved').textContent = `Approved: ${data.approved_count}`;

    // Color budget remaining
    const budgetEl = document.getElementById('kpi-budget-remaining');
    if (data.budget_limit > 0) {
      const pct = data.budget_remaining / data.budget_limit;
      if (pct < 0.2) budgetEl.classList.add('red');
      else if (pct < 0.4) budgetEl.classList.remove('green');
    }
  } catch (e) {
    console.error('KPI load error:', e);
  }
}

async function loadModels() {
  try {
    const models = await API.get('/api/models');
    const sel = document.getElementById('proj-model');
    models.forEach(m => {
      const opt = document.createElement('option');
      opt.value = m.cost_per_image || 0.01;
      opt.textContent = `${m.label} (${formatCost(m.cost_per_image)}/img)`;
      if (m.default) opt.selected = true;
      sel.appendChild(opt);
    });
    updateProjector();
  } catch (e) {}
}

async function loadTimelineChart() {
  const days = document.getElementById('timeline-days').value;
  try {
    const data = await API.get(`/api/analytics/costs/timeline?days=${days}`);
    const ctx = document.getElementById('chart-timeline').getContext('2d');

    if (charts.timeline) charts.timeline.destroy();

    charts.timeline = new Chart(ctx, {
      type: 'line',
      data: {
        labels: data.map(d => d.day),
        datasets: [{
          label: 'Daily Cost ($)',
          data: data.map(d => d.total_cost),
          borderColor: CHART_COLORS.gold,
          backgroundColor: 'rgba(197,165,90,.1)',
          fill: true,
          tension: 0.4,
          pointRadius: 3,
          pointBackgroundColor: CHART_COLORS.gold,
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { grid: { display: false }, ticks: { font: { size: 11 } } },
          y: { beginAtZero: true, ticks: { callback: v => '$' + v.toFixed(3), font: { size: 11 } } }
        }
      }
    });
  } catch (e) {}
}

async function loadModelChart() {
  try {
    const data = await API.get('/api/analytics/costs/by-model');
    const ctx = document.getElementById('chart-by-model').getContext('2d');
    if (charts.byModel) charts.byModel.destroy();

    charts.byModel = new Chart(ctx, {
      type: 'doughnut',
      data: {
        labels: data.map(d => d.model),
        datasets: [{
          data: data.map(d => d.total_cost),
          backgroundColor: CHART_COLORS.models,
          borderWidth: 2,
          borderColor: '#fff',
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { position: 'bottom', labels: { font: { size: 11 }, padding: 12 } },
          tooltip: { callbacks: { label: ctx => `${ctx.label}: $${ctx.raw?.toFixed(4)}` } }
        }
      }
    });
  } catch (e) {}
}

async function loadQualityChart() {
  try {
    const data = await API.get('/api/analytics/quality/distribution');
    const ctx = document.getElementById('chart-quality').getContext('2d');
    if (charts.quality) charts.quality.destroy();

    charts.quality = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: data.map(d => d.bucket),
        datasets: [{
          label: 'Images',
          data: data.map(d => d.count),
          backgroundColor: CHART_COLORS.navy,
          borderRadius: 3,
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { grid: { display: false }, ticks: { font: { size: 11 } } },
          y: { beginAtZero: true, ticks: { font: { size: 11 } } }
        }
      }
    });
  } catch (e) {}
}

function setupProjector() {
  ['proj-books', 'proj-variants', 'proj-model'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', updateProjector);
  });
}

function updateProjector() {
  const books = parseInt(document.getElementById('proj-books')?.value) || 0;
  const variants = parseInt(document.getElementById('proj-variants')?.value) || 1;
  const costPerImage = parseFloat(document.getElementById('proj-model')?.value) || 0.01;
  const total = books * variants * costPerImage;
  document.getElementById('proj-result').textContent = formatCost(total);
}

function setupEventListeners() {
  document.getElementById('timeline-days').addEventListener('change', loadTimelineChart);
  document.getElementById('refresh-btn').addEventListener('click', async () => {
    await loadKPIs();
    await loadTimelineChart();
    await loadModelChart();
    await loadQualityChart();
    toast('Dashboard refreshed', 'success');
  });
}

document.addEventListener('DOMContentLoaded', init);
