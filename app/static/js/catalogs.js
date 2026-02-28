/**
 * catalogs.js — Catalog management page
 */

let allBooks = [];
let filteredBooks = [];
let currentPage = 0;
const PAGE_SIZE = 50;

async function init() {
  await loadCostBadge();
  await loadCatalog();
  setupEventListeners();
}

async function loadCostBadge() {
  try {
    const data = await API.get('/api/analytics/costs');
    const el = document.getElementById('cost-today');
    if (el) el.textContent = formatCost(data.today);
  } catch (e) {}
}

async function loadCatalog() {
  try {
    const data = await API.get('/api/catalogs');
    allBooks = data.books || [];
    filteredBooks = allBooks;

    // Update stats
    document.getElementById('stat-total-books').textContent = data.stats.total_books;
    document.getElementById('stat-generated').textContent = data.stats.books_generated;
    document.getElementById('stat-total-cost').textContent = formatCost(data.stats.total_cost);
    document.getElementById('stat-with-cover').textContent = allBooks.filter(b => b.cover_cached_path).length;

    applyFilters();
  } catch (e) {
    toast('Failed to load catalog: ' + e.message, 'error');
  }
}

function applyFilters() {
  const search = document.getElementById('catalog-search').value.toLowerCase();
  const genre = document.getElementById('filter-genre').value.toLowerCase();
  const show = document.getElementById('filter-show').value;

  filteredBooks = allBooks.filter(b => {
    const titleMatch = (b.title || '').toLowerCase().includes(search) ||
                       (b.author || '').toLowerCase().includes(search);
    const genreMatch = !genre || (b.genre || '').toLowerCase().includes(genre);
    let showMatch = true;
    if (show === 'generated') showMatch = b.has_variants;
    if (show === 'no_cover') showMatch = !b.cover_cached_path;
    return titleMatch && genreMatch && showMatch;
  });

  currentPage = 0;
  renderTable();
  updatePagination();
}

function renderTable() {
  const tbody = document.getElementById('catalog-tbody');
  const start = currentPage * PAGE_SIZE;
  const page = filteredBooks.slice(start, start + PAGE_SIZE);

  if (!page.length) {
    tbody.innerHTML = '<tr><td colspan="9" style="text-align:center; padding:30px; color:var(--text-muted);">No books found</td></tr>';
    return;
  }

  tbody.innerHTML = page.map(b => `
    <tr>
      <td class="muted">${b.number || '—'}</td>
      <td><strong>${escapeHtml(b.title || '')}</strong></td>
      <td>${escapeHtml(b.author || '')}</td>
      <td><span class="pill pill-navy" style="font-size:0.65rem;">${escapeHtml(b.genre || '—')}</span></td>
      <td style="font-size:0.75rem; color:var(--text-muted);">${escapeHtml(b.themes || '—')}</td>
      <td style="font-size:0.75rem; color:var(--text-muted);">${escapeHtml(b.era || '—')}</td>
      <td>
        ${b.has_cover
          ? `<img src="/api/books/${b.id}/cover-preview" style="width:28px; height:36px; object-fit:cover; border-radius:2px; border:1px solid var(--border);" onerror="this.style.display='none'">`
          : '<span class="pill" style="background:rgba(201,64,64,.08); color:var(--red); font-size:0.65rem;">No cover</span>'}
      </td>
      <td id="variant-count-${b.id}"><span style="color:var(--text-muted); font-size:0.8rem;">—</span></td>
      <td>
        <div style="display:flex; gap:4px;">
          <button class="btn btn-ghost btn-sm" onclick="editBook('${b.id}')" style="padding:3px 8px;">Edit</button>
          <a href="/iterate?book=${b.id}" class="btn btn-ghost btn-sm" style="padding:3px 8px; text-decoration:none;">Gen →</a>
        </div>
      </td>
    </tr>
  `).join('');

  // Lazy-load variant counts
  page.forEach(b => loadVariantCount(b.id));
}

async function loadVariantCount(bookId) {
  try {
    const jobs = await API.get(`/api/jobs?book_id=${bookId}&status=completed&limit=20`);
    const el = document.getElementById(`variant-count-${bookId}`);
    if (el) {
      el.innerHTML = jobs.length
        ? `<span class="pill pill-green" style="font-size:0.65rem;">${jobs.length} variant${jobs.length !== 1 ? 's' : ''}</span>`
        : '<span style="color:var(--text-muted); font-size:0.8rem;">0</span>';
    }
  } catch (e) {}
}

function editBook(id) {
  const book = allBooks.find(b => b.id === id);
  if (!book) return;
  document.getElementById('edit-book-id').value = id;
  document.getElementById('edit-title').value = book.title || '';
  document.getElementById('edit-author').value = book.author || '';
  document.getElementById('edit-genre').value = book.genre || '';
  document.getElementById('edit-themes').value = book.themes || '';
  document.getElementById('edit-era').value = book.era || '';
  document.getElementById('edit-book-modal').classList.remove('hidden');
}

async function saveBookEdit() {
  const id = document.getElementById('edit-book-id').value;
  const data = {
    title: document.getElementById('edit-title').value,
    author: document.getElementById('edit-author').value,
    genre: document.getElementById('edit-genre').value,
    themes: document.getElementById('edit-themes').value,
    era: document.getElementById('edit-era').value,
  };
  try {
    const r = await fetch(`/api/books/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (!r.ok) throw new Error(await r.text());
    toast('Book updated', 'success');
    document.getElementById('edit-book-modal').classList.add('hidden');
    await loadCatalog();
  } catch (e) {
    toast('Save failed: ' + e.message, 'error');
  }
}

function updatePagination() {
  const total = filteredBooks.length;
  const start = currentPage * PAGE_SIZE + 1;
  const end = Math.min((currentPage + 1) * PAGE_SIZE, total);
  document.getElementById('catalog-count').textContent = total > 0 ? `${start}–${end} of ${total}` : '0 books';
  document.getElementById('prev-page').disabled = currentPage === 0;
  document.getElementById('next-page').disabled = end >= total;
}

function escapeHtml(s) {
  return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function setupEventListeners() {
  document.getElementById('catalog-search').addEventListener('input', applyFilters);
  document.getElementById('filter-genre').addEventListener('input', applyFilters);
  document.getElementById('filter-show').addEventListener('change', applyFilters);

  document.getElementById('prev-page').addEventListener('click', () => {
    if (currentPage > 0) { currentPage--; renderTable(); updatePagination(); }
  });

  document.getElementById('next-page').addEventListener('click', () => {
    currentPage++;
    renderTable();
    updatePagination();
  });

  document.getElementById('sync-btn').addEventListener('click', async () => {
    const btn = document.getElementById('sync-btn');
    btn.disabled = true;
    btn.textContent = '↻ Syncing…';
    try {
      const result = await API.post('/api/catalogs/sync', {});
      toast(`Sync complete: ${result.synced} books`, 'success');
      await loadCatalog();
    } catch (e) {
      toast('Sync failed: ' + e.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = '↻ Sync from Drive';
    }
  });

  document.getElementById('export-catalog-btn').addEventListener('click', () => {
    window.location.href = '/api/history/export';
  });

  document.getElementById('save-book-btn').addEventListener('click', saveBookEdit);
}

document.addEventListener('DOMContentLoaded', init);
window.editBook = editBook;
