/**
 * batch.js — Batch generation page
 */

let allBooks = [];
let selectedBookIds = new Set();
let models = [];
let activeBatchId = null;
let batchSSE = null;
let startTime = null;

async function init() {
  await loadCostBadge();
  await loadBooks();
  await loadModels();
  await loadBatchHistory();
  setupEventListeners();
}

async function loadCostBadge() {
  try {
    const data = await API.get('/api/analytics/costs');
    const el = document.getElementById('cost-today');
    if (el) el.textContent = formatCost(data.today);
  } catch (e) {}
}

async function loadBooks() {
  try {
    allBooks = await API.get('/api/books');
    renderBookGrid(allBooks);
  } catch (e) {
    toast('Failed to load books: ' + e.message, 'error');
  }
}

async function loadModels() {
  try {
    models = await API.get('/api/models');
    const select = document.getElementById('batch-model');
    models.forEach(m => {
      const opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = `${m.label} ($${m.cost_per_image?.toFixed(3)}/img)`;
      if (m.default) opt.selected = true;
      select.appendChild(opt);
    });
    updateCostEstimate();
  } catch (e) {}
}

async function loadBatchHistory() {
  try {
    const batches = await API.get('/api/batches');
    const tbody = document.getElementById('batch-history-body');
    if (!batches.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="muted" style="text-align:center; padding:20px;">No past batches</td></tr>';
      return;
    }
    tbody.innerHTML = batches.map(b => `
      <tr>
        <td>${b.name || b.id.slice(0, 8)}</td>
        <td>${b.total_books}</td>
        <td><code style="font-size:0.75rem;">${b.model}</code></td>
        <td><span class="job-status-badge status-${b.status}">${b.status}</span></td>
        <td>${formatCost(b.total_cost)}</td>
        <td>${new Date(b.created_at).toLocaleString()}</td>
      </tr>
    `).join('');
  } catch (e) {}
}

function renderBookGrid(books) {
  const grid = document.getElementById('book-grid');
  if (!books.length) {
    grid.innerHTML = '<div style="color:var(--text-muted); font-size:0.8rem; padding:8px;">No books found</div>';
    return;
  }
  grid.innerHTML = books.map(b => `
    <div class="book-select-item ${selectedBookIds.has(b.id) ? 'selected' : ''}"
         data-id="${b.id}">
      <input type="checkbox" ${selectedBookIds.has(b.id) ? 'checked' : ''}>
      <div>
        <div class="book-select-title">${b.title}</div>
        <div class="book-select-meta">${b.author || ''}</div>
      </div>
    </div>
  `).join('');

  grid.querySelectorAll('.book-select-item').forEach(item => {
    item.addEventListener('click', () => toggleBook(item.dataset.id, item));
  });
  updateSelectionCount();
}

function toggleBook(id, el) {
  if (selectedBookIds.has(id)) {
    selectedBookIds.delete(id);
    el.classList.remove('selected');
    el.querySelector('input[type="checkbox"]').checked = false;
  } else {
    selectedBookIds.add(id);
    el.classList.add('selected');
    el.querySelector('input[type="checkbox"]').checked = true;
  }
  updateSelectionCount();
  updateCostEstimate();
}

function updateSelectionCount() {
  const count = selectedBookIds.size;
  document.getElementById('selection-count').textContent = `${count} book${count !== 1 ? 's' : ''} selected`;
  document.getElementById('start-batch-btn').disabled = count === 0;
}

function updateCostEstimate() {
  const count = selectedBookIds.size;
  const variants = parseInt(document.getElementById('batch-variants').value) || 3;
  const model = document.getElementById('batch-model').value;
  const modelData = models.find(m => m.id === model);
  const costPer = modelData ? modelData.cost_per_image : 0.01;
  const total = count * variants * costPer;
  document.getElementById('cost-estimate').textContent = formatCost(total);
  document.getElementById('cost-breakdown').textContent =
    `${count} books × ${variants} variants × ${formatCost(costPer)}/image`;
}

async function startBatch() {
  const btn = document.getElementById('start-batch-btn');
  if (selectedBookIds.size === 0) return;

  btn.disabled = true;
  btn.textContent = 'Starting…';

  try {
    const result = await API.post('/api/batch-generate', {
      book_ids: Array.from(selectedBookIds),
      model: document.getElementById('batch-model').value,
      variant_count: parseInt(document.getElementById('batch-variants').value),
      prompt_strategy: document.getElementById('batch-strategy').value,
      name: document.getElementById('batch-name-input').value || null,
    });

    activeBatchId = result.batch_id;
    startTime = Date.now();
    showBatchProgress(result);
    pollBatchStatus();
  } catch (e) {
    toast('Failed to start batch: ' + e.message, 'error');
    btn.disabled = false;
    btn.textContent = 'Start Batch';
  }
}

function showBatchProgress(result) {
  document.getElementById('batch-setup-section').classList.add('hidden');
  const section = document.getElementById('active-batch-section');
  section.classList.remove('hidden');
  document.getElementById('b-total').textContent = result.total_books;
  document.getElementById('b-completed').textContent = 0;
}

async function pollBatchStatus() {
  if (!activeBatchId) return;

  try {
    const batch = await API.get(`/api/batch/${activeBatchId}/status`);
    updateBatchUI(batch);

    if (['completed', 'failed', 'cancelled'].includes(batch.status)) {
      clearTimeout(pollBatchStatus._timer);
      await loadBatchHistory();
      document.getElementById('start-batch-btn').disabled = false;
      document.getElementById('start-batch-btn').textContent = 'Start Batch';
      return;
    }
  } catch (e) {}

  pollBatchStatus._timer = setTimeout(pollBatchStatus, 2000);
}

function updateBatchUI(batch) {
  document.getElementById('b-completed').textContent = batch.completed_books || 0;
  document.getElementById('b-total').textContent = batch.total_books;
  document.getElementById('b-cost').textContent = formatCost(batch.total_cost);

  const pct = batch.total_books > 0
    ? Math.round((batch.completed_books / batch.total_books) * 100)
    : 0;
  document.getElementById('batch-progress-fill').style.width = pct + '%';

  if (startTime && batch.completed_books > 0) {
    const elapsed = (Date.now() - startTime) / 1000;
    const rate = batch.completed_books / elapsed;
    const remaining = (batch.total_books - batch.completed_books) / Math.max(rate, 0.001);
    const mins = Math.floor(remaining / 60);
    const secs = Math.floor(remaining % 60);
    document.getElementById('b-eta').textContent = `${mins}m ${secs}s`;
  }

  document.getElementById('b-status-text').textContent = `Status: ${batch.status}`;

  const dot = document.getElementById('batch-dot');
  dot.className = 'stage-dot ' + (batch.status === 'running' ? 'active' : 'done');

  if (batch.current_book_id) {
    document.getElementById('batch-current-book').textContent = `Processing: ${batch.current_book_id}`;
  }
}

function setupEventListeners() {
  document.getElementById('select-all-btn').addEventListener('click', () => {
    allBooks.forEach(b => selectedBookIds.add(b.id));
    renderBookGrid(allBooks);
  });

  document.getElementById('deselect-all-btn').addEventListener('click', () => {
    selectedBookIds.clear();
    renderBookGrid(allBooks);
  });

  document.getElementById('select-ungenerated-btn').addEventListener('click', async () => {
    // Select books that have no completed jobs
    try {
      const jobs = await API.get('/api/jobs?limit=500&status=completed');
      const generatedIds = new Set(jobs.map(j => j.book_id));
      selectedBookIds.clear();
      allBooks.forEach(b => { if (!generatedIds.has(b.id)) selectedBookIds.add(b.id); });
      renderBookGrid(allBooks);
    } catch (e) {
      toast('Failed: ' + e.message, 'error');
    }
  });

  document.getElementById('book-search').addEventListener('input', (e) => {
    const q = e.target.value.toLowerCase();
    const filtered = allBooks.filter(b =>
      (b.title || '').toLowerCase().includes(q) ||
      (b.author || '').toLowerCase().includes(q)
    );
    renderBookGrid(filtered);
  });

  document.getElementById('batch-variants').addEventListener('change', updateCostEstimate);
  document.getElementById('batch-model').addEventListener('change', updateCostEstimate);

  document.getElementById('start-batch-btn').addEventListener('click', startBatch);

  document.getElementById('pause-btn').addEventListener('click', async () => {
    if (!activeBatchId) return;
    await API.post(`/api/batch/${activeBatchId}/pause`);
    toast('Batch paused', 'info');
    document.getElementById('pause-btn').classList.add('hidden');
    document.getElementById('resume-btn').classList.remove('hidden');
  });

  document.getElementById('resume-btn').addEventListener('click', async () => {
    if (!activeBatchId) return;
    await API.post(`/api/batch/${activeBatchId}/resume`);
    toast('Batch resumed', 'info');
    document.getElementById('resume-btn').classList.add('hidden');
    document.getElementById('pause-btn').classList.remove('hidden');
    pollBatchStatus();
  });

  document.getElementById('cancel-btn').addEventListener('click', async () => {
    if (!activeBatchId) return;
    await API.post(`/api/batch/${activeBatchId}/cancel`);
    toast('Batch cancelled', 'warn');
    document.getElementById('active-batch-section').classList.add('hidden');
    document.getElementById('batch-setup-section').classList.remove('hidden');
    activeBatchId = null;
  });
}

document.addEventListener('DOMContentLoaded', init);
