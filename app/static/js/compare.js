/**
 * compare.js — Side-by-side book comparison
 */

let allBooks = [];

async function init() {
  await loadCostBadge();
  await loadBooks();
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
    const selects = document.querySelectorAll('.compare-book-select');
    selects.forEach(sel => {
      allBooks.forEach(b => {
        const opt = document.createElement('option');
        opt.value = b.id;
        opt.textContent = `${b.title}${b.author ? ' — ' + b.author : ''}`;
        sel.appendChild(opt);
      });
    });
  } catch (e) {
    toast('Failed to load books: ' + e.message, 'error');
  }
}

async function compareBooks() {
  const selects = document.querySelectorAll('.compare-book-select');
  const ids = Array.from(selects).map(s => s.value).filter(Boolean);
  if (ids.length < 1) {
    toast('Select at least one book to compare', 'warn');
    return;
  }

  const btn = document.getElementById('compare-btn');
  btn.disabled = true;
  btn.textContent = 'Loading…';

  try {
    const data = await API.get(`/api/compare?book_ids=${ids.join(',')}`);
    renderComparison(data);
  } catch (e) {
    toast('Compare failed: ' + e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Compare →';
  }
}

function renderComparison(books) {
  const container = document.getElementById('compare-result');
  if (!books.length) {
    container.innerHTML = '<div class="empty-state"><p>No data for selected books</p></div>';
    return;
  }

  container.innerHTML = books.map(book => {
    const variants = book.variants || [];
    const bestVariant = variants[0]; // Already sorted by quality DESC

    const variantHtml = variants.length
      ? variants.slice(0, 5).map(v => `
          <div class="compare-variant">
            <img src="/api/jobs/${v.id}/result-thumbnail" alt="Variant"
                 onerror="this.style.display='none'" loading="lazy">
            <div class="compare-variant-info">
              <span>V${v.variant || 1}</span>
              <span>${v.quality_score != null ? formatScore(v.quality_score) : '—'}</span>
              <span><code style="font-size:0.65rem;">${v.model}</code></span>
            </div>
          </div>`).join('')
      : '<div style="padding:16px; color:var(--text-muted); font-size:0.8rem; text-align:center;">No variants yet.<br><a href="/iterate" style="color:var(--navy);">Generate →</a></div>';

    const avgQuality = variants.length
      ? variants.reduce((s, v) => s + (v.quality_score || 0), 0) / variants.length
      : null;

    return `
      <div class="compare-col">
        <div class="compare-col-header">
          <div class="compare-col-title">${book.title || 'Unknown'}</div>
          <div class="compare-col-meta">${book.author || ''}</div>
        </div>
        <div class="compare-variants">${variantHtml}</div>
        <div class="compare-stats">
          <div class="compare-stat-label">Variants</div>
          <div class="compare-stat-value">${variants.length}</div>
          <div class="compare-stat-label">Best Quality</div>
          <div class="compare-stat-value">${bestVariant?.quality_score != null ? formatScore(bestVariant.quality_score) : '—'}</div>
          <div class="compare-stat-label">Avg Quality</div>
          <div class="compare-stat-value">${avgQuality != null ? formatScore(avgQuality) : '—'}</div>
          <div class="compare-stat-label">Total Cost</div>
          <div class="compare-stat-value">${formatCost(book.total_cost)}</div>
          <div class="compare-stat-label">Winner</div>
          <div class="compare-stat-value">${book.winner_job_id ? '✓ Selected' : '—'}</div>
        </div>
      </div>`;
  }).join('');
}

function setupEventListeners() {
  const selects = document.querySelectorAll('.compare-book-select');
  selects.forEach(sel => {
    sel.addEventListener('change', () => {
      const hasSelection = Array.from(selects).some(s => s.value);
      document.getElementById('compare-btn').disabled = !hasSelection;
    });
  });

  document.getElementById('compare-btn').addEventListener('click', compareBooks);
}

document.addEventListener('DOMContentLoaded', init);
