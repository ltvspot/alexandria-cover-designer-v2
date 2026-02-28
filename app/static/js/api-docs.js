/**
 * api-docs.js — API documentation page
 */

const ENDPOINT_DESCRIPTIONS = {
  '/api/health': 'Health check endpoint',
  '/api/books': 'List all books in catalog',
  '/api/books/{book_id}': 'Get book details by ID',
  '/api/books/{book_id}/cover-preview': 'Return thumbnail for a book cover',
  '/api/generate': 'Queue new generation jobs for a book',
  '/api/jobs': 'List all jobs with optional filters',
  '/api/jobs/{job_id}': 'Get job details',
  '/api/jobs/{job_id}/cancel': 'Cancel a queued job',
  '/api/jobs/{job_id}/retry': 'Retry a failed/cancelled job',
  '/api/jobs/{job_id}/result-image': 'Return generated image for completed job',
  '/api/jobs/{job_id}/result-thumbnail': 'Return thumbnail of result image',
  '/api/models': 'List available generation models',
  '/api/analytics/costs': 'Cost summary (total, today)',
  '/api/analytics/budget': 'Budget status and remaining amount',
  '/api/analytics/dashboard': 'Aggregated KPIs for dashboard',
  '/api/analytics/costs/timeline': 'Daily cost data for chart',
  '/api/analytics/costs/by-model': 'Cost breakdown by model',
  '/api/analytics/quality/distribution': 'Quality score histogram',
  '/api/analytics/models/compare': 'Model performance comparison table',
  '/api/history': 'Paginated job history with filters',
  '/api/history/export': 'Export history as CSV file',
  '/api/review-data': 'Books with variants for review page',
  '/api/save-selections': 'Save winning variant selections',
  '/api/batch-approve': 'Auto-approve books above quality threshold',
  '/api/batch-generate': 'Start a batch generation run',
  '/api/batch/{batch_id}/status': 'Get batch job progress',
  '/api/batch/{batch_id}/pause': 'Pause a running batch',
  '/api/batch/{batch_id}/resume': 'Resume a paused batch',
  '/api/batch/{batch_id}/cancel': 'Cancel a batch job',
  '/api/batches': 'List all batch jobs',
  '/api/prompts': 'List or create prompts',
  '/api/prompts/seed-builtins': 'Seed built-in style profiles',
  '/api/prompts/{prompt_id}': 'Get, update, or delete a prompt',
  '/api/prompts/{prompt_id}/versions': 'Get prompt version history',
  '/api/compare': 'Side-by-side book comparison data',
  '/api/similarity-matrix': 'Similarity data for all completed jobs',
  '/api/similarity-compute': 'Trigger similarity computation',
  '/api/settings': 'Get or update application settings',
  '/api/catalogs': 'Catalog stats and book list',
  '/api/catalogs/sync': 'Trigger Drive catalog sync',
  '/api/endpoints': 'List all API endpoints (this endpoint)',
};

let allEndpoints = [];

async function init() {
  await loadCostBadge();
  await loadEndpoints();
  setupEventListeners();
}

async function loadCostBadge() {
  try {
    const data = await API.get('/api/analytics/costs');
    const el = document.getElementById('cost-today');
    if (el) el.textContent = formatCost(data.today);
  } catch (e) {}
}

async function loadEndpoints() {
  try {
    // Use the FastAPI openapi.json for the real list
    const openapi = await API.get('/openapi.json');
    allEndpoints = [];
    Object.entries(openapi.paths || {}).forEach(([path, methods]) => {
      Object.entries(methods).forEach(([method, info]) => {
        if (['get', 'post', 'put', 'delete', 'patch'].includes(method)) {
          allEndpoints.push({
            path,
            method: method.toUpperCase(),
            summary: info.summary || info.description || ENDPOINT_DESCRIPTIONS[path] || '',
            operationId: info.operationId || '',
            tags: info.tags || [],
          });
        }
      });
    });
    document.getElementById('endpoint-count').textContent = `${allEndpoints.length} endpoints`;
    renderEndpoints(allEndpoints);
  } catch (e) {
    // Fallback: use our own /api/endpoints
    try {
      const data = await API.get('/api/endpoints');
      allEndpoints = data.flatMap(ep =>
        ep.methods.map(m => ({
          path: ep.path,
          method: m,
          summary: ep.summary || ENDPOINT_DESCRIPTIONS[ep.path] || '',
        }))
      );
      document.getElementById('endpoint-count').textContent = `${allEndpoints.length} endpoints`;
      renderEndpoints(allEndpoints);
    } catch (e2) {
      document.getElementById('endpoints-container').innerHTML =
        `<div style="color:var(--red); padding:20px;">Failed to load endpoints: ${e2.message}</div>`;
    }
  }
}

function renderEndpoints(endpoints) {
  const search = document.getElementById('endpoint-search').value.toLowerCase();
  const methodFilter = document.getElementById('method-filter').value;
  const groupFilter = document.getElementById('group-filter').value;

  const filtered = endpoints.filter(ep => {
    const matchSearch = !search || ep.path.toLowerCase().includes(search) || ep.summary.toLowerCase().includes(search);
    const matchMethod = !methodFilter || ep.method === methodFilter;
    const matchGroup = !groupFilter || ep.path.startsWith(groupFilter);
    return matchSearch && matchMethod && matchGroup;
  });

  // Group by path prefix
  const groups = {};
  filtered.forEach(ep => {
    const parts = ep.path.split('/');
    const group = parts.length >= 3 ? '/' + parts[1] + '/' + parts[2] : ep.path;
    if (!groups[group]) groups[group] = [];
    groups[group].push(ep);
  });

  const container = document.getElementById('endpoints-container');
  if (!filtered.length) {
    container.innerHTML = '<div style="padding:20px; color:var(--text-muted);">No endpoints match your filters</div>';
    return;
  }

  container.innerHTML = Object.entries(groups).map(([group, eps]) => `
    <div class="endpoint-group">
      ${eps.map(ep => `
        <div class="endpoint-row" onclick="toggleDetail(this)">
          <span class="method-badge method-${ep.method}">${ep.method}</span>
          <span class="endpoint-path">${ep.path}</span>
          <span class="endpoint-desc">${ep.summary || ''}</span>
        </div>
      `).join('')}
    </div>
  `).join('');
}

function toggleDetail(el) {
  // Expand inline (simple version)
  el.classList.toggle('expanded');
}

function setupEventListeners() {
  document.getElementById('endpoint-search').addEventListener('input', () => renderEndpoints(allEndpoints));
  document.getElementById('method-filter').addEventListener('change', () => renderEndpoints(allEndpoints));
  document.getElementById('group-filter').addEventListener('change', () => renderEndpoints(allEndpoints));
  document.getElementById('refresh-btn').addEventListener('click', loadEndpoints);
}

document.addEventListener('DOMContentLoaded', init);
window.toggleDetail = toggleDetail;
