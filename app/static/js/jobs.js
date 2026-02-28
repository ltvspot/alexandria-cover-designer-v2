/**
 * jobs.js — Job queue page with auto-refresh
 */

let autoRefresh = true;
let refreshInterval = null;
let statusFilter = '';
let limitVal = 50;

async function init() {
  await loadCostBadge();
  await loadJobs();
  startAutoRefresh();
  setupEventListeners();
}

async function loadCostBadge() {
  try {
    const data = await API.get('/api/analytics/costs');
    const el = document.getElementById('cost-today');
    if (el) el.textContent = formatCost(data.today);
  } catch (e) {}
}

async function loadJobs() {
  const params = new URLSearchParams({ limit: limitVal });
  if (statusFilter) params.set('status', statusFilter);

  try {
    const jobs = await API.get(`/api/jobs?${params}`);
    renderSummary(jobs);
    renderTable(jobs);
  } catch (e) {
    console.error('Jobs load error:', e);
  }
}

function renderSummary(jobs) {
  const counts = { queued: 0, running: 0, completed: 0, failed: 0, cancelled: 0 };
  jobs.forEach(j => { if (counts[j.status] !== undefined) counts[j.status]++; });
  document.getElementById('stat-queued').textContent = counts.queued;
  document.getElementById('stat-running').textContent = counts.running;
  document.getElementById('stat-completed').textContent = counts.completed;
  document.getElementById('stat-failed').textContent = counts.failed;
  document.getElementById('stat-cancelled').textContent = counts.cancelled;
}

function renderTable(jobs) {
  const tbody = document.getElementById('jobs-tbody');
  if (!jobs.length) {
    tbody.innerHTML = '<tr><td colspan="9" style="text-align:center; padding:30px; color:var(--text-muted);">No jobs</td></tr>';
    return;
  }

  tbody.innerHTML = jobs.map(j => `
    <tr>
      <td class="muted" style="font-family:monospace; font-size:0.7rem;">${j.id.slice(0, 8)}…</td>
      <td>${j.book_id.slice(0, 12)}…</td>
      <td><code style="font-size:0.7rem;">${j.model}</code></td>
      <td class="muted">V${j.variant || 1}</td>
      <td>${statusBadge(j.status).outerHTML}</td>
      <td>${j.quality_score != null ? formatScore(j.quality_score) : '—'}</td>
      <td>${formatCost(j.cost_usd)}</td>
      <td class="muted">${formatDate(j.created_at)}</td>
      <td>
        <div style="display:flex; gap:4px;">
          <button class="btn btn-ghost btn-sm" onclick="showJobDetail('${j.id}')" style="padding:3px 8px;">View</button>
          ${j.status === 'queued' ? `<button class="btn btn-ghost btn-sm" onclick="cancelJob('${j.id}')" style="padding:3px 8px; color:var(--red);">✕</button>` : ''}
          ${j.status === 'failed' || j.status === 'cancelled' ? `<button class="btn btn-ghost btn-sm" onclick="retryJob('${j.id}')" style="padding:3px 8px;">↻</button>` : ''}
        </div>
      </td>
    </tr>
  `).join('');
}

async function showJobDetail(id) {
  const modal = document.getElementById('job-detail-modal');
  const body = document.getElementById('job-detail-body');
  body.innerHTML = '<div style="padding:20px; color:var(--text-muted);">Loading…</div>';
  modal.classList.remove('hidden');

  try {
    const j = await API.get(`/api/jobs/${id}`);
    body.innerHTML = `
      <div style="display:grid; grid-template-columns: 1fr 1fr; gap:14px; margin-bottom:16px;">
        <div><strong>Job ID</strong><div style="font-family:monospace; font-size:0.8rem;">${j.id}</div></div>
        <div><strong>Status</strong><div>${statusBadge(j.status).outerHTML}</div></div>
        <div><strong>Model</strong><div><code style="font-size:0.8rem;">${j.model}</code></div></div>
        <div><strong>Variant</strong><div>V${j.variant || 1}</div></div>
        <div><strong>Quality</strong><div>${j.quality_score != null ? formatScore(j.quality_score) : '—'}</div></div>
        <div><strong>Cost</strong><div>${formatCost(j.cost_usd)}</div></div>
        <div><strong>Created</strong><div style="font-size:0.8rem;">${formatDate(j.created_at)}</div></div>
        <div><strong>Completed</strong><div style="font-size:0.8rem;">${j.completed_at ? formatDate(j.completed_at) : '—'}</div></div>
      </div>
      ${j.error ? `<div class="alert alert-error" style="margin-bottom:12px;"><strong>Error:</strong> ${j.error}</div>` : ''}
      ${j.prompt ? `
        <strong>Prompt:</strong>
        <pre class="expand-prompt" style="margin-top:6px;">${escapeHtml(j.prompt)}</pre>
      ` : ''}
      ${j.status === 'completed' ? `
        <div style="margin-top:14px;">
          <img src="/api/jobs/${j.id}/result-thumbnail"
               style="max-width:200px; border-radius:4px; border:1px solid var(--border);"
               onerror="this.style.display='none'" alt="Result">
        </div>
      ` : ''}
    `;
  } catch (e) {
    body.innerHTML = `<div style="padding:20px; color:var(--red);">Error: ${e.message}</div>`;
  }
}

async function cancelJob(id) {
  try {
    await API.post(`/api/jobs/${id}/cancel`);
    toast('Job cancelled', 'success');
    await loadJobs();
  } catch (e) {
    toast('Cancel failed: ' + e.message, 'error');
  }
}

async function retryJob(id) {
  try {
    await API.post(`/api/jobs/${id}/retry`);
    toast('Job requeued', 'success');
    await loadJobs();
  } catch (e) {
    toast('Retry failed: ' + e.message, 'error');
  }
}

function startAutoRefresh() {
  refreshInterval = setInterval(loadJobs, 3000);
}

function stopAutoRefresh() {
  clearInterval(refreshInterval);
}

function formatDate(s) {
  if (!s) return '—';
  return new Date(s).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function escapeHtml(s) {
  return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function setupEventListeners() {
  document.getElementById('apply-filter-btn').addEventListener('click', async () => {
    statusFilter = document.getElementById('status-filter').value;
    limitVal = parseInt(document.getElementById('limit-filter').value) || 50;
    await loadJobs();
  });

  document.getElementById('status-filter').addEventListener('change', async () => {
    statusFilter = document.getElementById('status-filter').value;
    await loadJobs();
  });

  document.getElementById('refresh-btn').addEventListener('click', () => {
    autoRefresh = !autoRefresh;
    document.getElementById('refresh-status').textContent = autoRefresh ? 'ON' : 'OFF';
    if (autoRefresh) startAutoRefresh();
    else stopAutoRefresh();
  });
}

document.addEventListener('DOMContentLoaded', init);
window.showJobDetail = showJobDetail;
window.cancelJob = cancelJob;
window.retryJob = retryJob;
