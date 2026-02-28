/**
 * history.js — Job history page
 */

let currentPage = 0;
const PAGE_SIZE = 50;
let filters = {};
let totalRows = 0;
let allModels = [];

async function init() {
  await loadCostBadge();
  await loadModels();
  await loadHistory();
  setupEventListeners();
}

async function loadCostBadge() {
  try {
    const data = await API.get('/api/analytics/costs');
    const el = document.getElementById('cost-today');
    if (el) el.textContent = formatCost(data.today);
  } catch (e) {}
}

async function loadModels() {
  try {
    const models = await API.get('/api/models');
    const sel = document.getElementById('filter-model');
    models.forEach(m => {
      const opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = m.label;
      sel.appendChild(opt);
    });
    allModels = models;
  } catch (e) {}
}

async function loadHistory() {
  const tbody = document.getElementById('history-tbody');
  tbody.innerHTML = '<tr><td colspan="8" style="text-align:center; padding:20px; color:var(--text-muted);">Loading…</td></tr>';

  const params = new URLSearchParams({
    limit: PAGE_SIZE,
    offset: currentPage * PAGE_SIZE,
    ...Object.fromEntries(Object.entries(filters).filter(([, v]) => v))
  });

  try {
    const data = await API.get(`/api/history?${params}`);
    totalRows = data.total;
    renderTable(data.items);
    updatePagination();
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="8" style="text-align:center; padding:20px; color:var(--red);">Error: ${e.message}</td></tr>`;
  }
}

function renderTable(rows) {
  const tbody = document.getElementById('history-tbody');
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="8" style="text-align:center; padding:30px; color:var(--text-muted);">No results</td></tr>';
    return;
  }

  tbody.innerHTML = rows.map(row => `
    <tr class="history-row" data-id="${row.id}" data-prompt="${encodeURIComponent(row.prompt || '')}">
      <td class="muted">${formatDate(row.created_at)}</td>
      <td><strong>${row.book_title || row.book_id}</strong><div class="muted" style="font-size:0.7rem;">${row.book_author || ''}</div></td>
      <td><code style="font-size:0.75rem;">${row.model}</code></td>
      <td class="muted">V${row.variant || 1}</td>
      <td>${row.quality_score != null ? formatScore(row.quality_score) : '—'}</td>
      <td>${formatCost(row.cost_usd)}</td>
      <td class="muted">${formatDuration(calcDuration(row))}</td>
      <td>${statusBadge(row.status).outerHTML}</td>
    </tr>
    <tr class="expand-row hidden" id="expand-${row.id}">
      <td colspan="8">
        <div class="expand-content">
          ${row.status === 'completed' ? `
            <img class="expand-image" src="/api/jobs/${row.id}/result-thumbnail"
                 onerror="this.style.display='none'" alt="Result">` : ''}
          <div class="expand-details">
            <h4>Job ID: ${row.id}</h4>
            <div style="margin-bottom:8px; font-size:0.8rem; color:var(--text-muted);">
              Started: ${row.started_at ? formatDate(row.started_at) : '—'} &nbsp;
              Completed: ${row.completed_at ? formatDate(row.completed_at) : '—'}
            </div>
            ${row.error ? `<div class="alert alert-error" style="margin-bottom:8px;">${row.error}</div>` : ''}
            <h4>Prompt Used:</h4>
            <pre class="expand-prompt">${row.prompt || 'Auto-generated'}</pre>
            <div style="display:flex; gap:8px; margin-top:10px;">
              ${row.status === 'completed' ? `<button class="btn btn-ghost btn-sm" onclick="downloadJobResult('${row.id}', '${(row.book_title || row.id).replace(/'/g, '')}')">⬇ Download</button>` : ''}
              ${row.status === 'failed' || row.status === 'cancelled' ? `<button class="btn btn-ghost btn-sm" onclick="retryJob('${row.id}')">↻ Retry</button>` : ''}
            </div>
          </div>
        </div>
      </td>
    </tr>
  `).join('');

  tbody.querySelectorAll('.history-row').forEach(row => {
    row.addEventListener('click', () => toggleExpand(row.dataset.id));
  });
}

function toggleExpand(id) {
  const expand = document.getElementById(`expand-${id}`);
  if (expand) expand.classList.toggle('hidden');
}

async function retryJob(id) {
  try {
    await API.post(`/api/jobs/${id}/retry`);
    toast('Job requeued', 'success');
    await loadHistory();
  } catch (e) {
    toast('Retry failed: ' + e.message, 'error');
  }
}

function formatDate(s) {
  if (!s) return '—';
  const d = new Date(s);
  return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function calcDuration(row) {
  if (!row.started_at || !row.completed_at) return null;
  return new Date(row.completed_at) - new Date(row.started_at);
}

function updatePagination() {
  const info = document.getElementById('pagination-info');
  const start = currentPage * PAGE_SIZE + 1;
  const end = Math.min((currentPage + 1) * PAGE_SIZE, totalRows);
  info.textContent = totalRows > 0 ? `${start}–${end} of ${totalRows}` : '0 results';

  document.getElementById('prev-page-btn').disabled = currentPage === 0;
  document.getElementById('next-page-btn').disabled = end >= totalRows;
}

function gatherFilters() {
  filters = {};
  const book = document.getElementById('filter-book').value.trim();
  if (book) filters.book_id = book;
  const model = document.getElementById('filter-model').value;
  if (model) filters.model = model;
  const status = document.getElementById('filter-status').value;
  if (status) filters.status = status;
  const from = document.getElementById('filter-from').value;
  if (from) filters.date_from = from;
  const to = document.getElementById('filter-to').value;
  if (to) filters.date_to = to;
  const qmin = document.getElementById('filter-qmin').value;
  if (qmin) filters.q_min = qmin;
}

function setupEventListeners() {
  document.getElementById('apply-filters-btn').addEventListener('click', async () => {
    gatherFilters();
    currentPage = 0;
    await loadHistory();
  });

  document.getElementById('clear-filters-btn').addEventListener('click', async () => {
    ['filter-book', 'filter-from', 'filter-to', 'filter-qmin'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });
    document.getElementById('filter-model').value = '';
    document.getElementById('filter-status').value = '';
    filters = {};
    currentPage = 0;
    await loadHistory();
  });

  document.getElementById('prev-page-btn').addEventListener('click', async () => {
    if (currentPage > 0) { currentPage--; await loadHistory(); }
  });

  document.getElementById('next-page-btn').addEventListener('click', async () => {
    currentPage++;
    await loadHistory();
  });

  document.getElementById('refresh-btn').addEventListener('click', loadHistory);

  document.getElementById('export-csv-btn').addEventListener('click', () => {
    window.location.href = '/api/history/export';
  });
}

document.addEventListener('DOMContentLoaded', init);
window.retryJob = retryJob;
