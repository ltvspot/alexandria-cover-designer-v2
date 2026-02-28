/**
 * review.js — Review page: select winning variants
 */

let allBooks = [];
let selections = {}; // { book_id: job_id }
let currentFilter = 'all';

async function init() {
  await loadCostBadge();
  await loadReviewData();
  setupEventListeners();
}

async function loadCostBadge() {
  try {
    const data = await API.get('/api/analytics/costs');
    const el = document.getElementById('cost-today');
    if (el) el.textContent = formatCost(data.today);
  } catch (e) {}
}

async function loadReviewData() {
  const grid = document.getElementById('review-grid');
  const stats = document.getElementById('review-stats');
  try {
    const books = await API.get(`/api/review-data?filter=${currentFilter}`);
    allBooks = books;

    // Restore selections from existing winners
    books.forEach(b => {
      if (b.winner_job_id) {
        selections[b.id] = b.winner_job_id;
      }
    });

    renderStats(books);
    renderGrid(books);
  } catch (e) {
    grid.innerHTML = `<div class="empty-state"><p>Error loading data: ${e.message}</p></div>`;
  }
}

function renderStats(books) {
  const total = books.length;
  const withVariants = books.filter(b => b.variants && b.variants.length > 0).length;
  const approved = books.filter(b => b.winner_job_id).length;
  document.getElementById('review-stats').textContent =
    `${total} books · ${withVariants} with variants · ${approved} approved`;
}

function renderGrid(books) {
  const grid = document.getElementById('review-grid');
  if (!books.length) {
    grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1;">
      <p>No books match the current filter.</p>
    </div>`;
    return;
  }

  grid.innerHTML = books.map(book => {
    const variants = book.variants || [];
    const selectedJobId = selections[book.id] || book.winner_job_id;

    const variantHtml = variants.length
      ? variants.map(v => `
          <div class="review-variant ${v.id === selectedJobId ? 'selected' : ''}"
               data-book-id="${book.id}" data-job-id="${v.id}"
               data-quality="${v.quality_score || 0}">
            <img src="/api/jobs/${v.id}/result-thumbnail" alt="Variant"
                 onerror="this.style.display='none'">
            <div class="v-score">${v.quality_score != null ? Math.round(v.quality_score * 100) + '%' : '—'}</div>
            <div class="v-check">
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                <path d="M2 5l2.5 2.5L8 3" stroke="white" stroke-width="1.5" stroke-linecap="round"/>
              </svg>
            </div>
          </div>`).join('')
      : `<div style="padding:16px; font-size:0.8rem; color:var(--text-muted);">No variants yet. <a href="/iterate" style="color:var(--navy);">Generate →</a></div>`;

    return `
      <div class="review-book-card">
        <div class="review-book-header">
          <div>
            <div class="review-book-title">${book.title || 'Unknown'}</div>
            <div class="review-book-author">${book.author || ''}</div>
          </div>
          ${book.winner_job_id
            ? `<span class="pill pill-green">Approved</span>`
            : variants.length
            ? `<span class="pill pill-navy">${variants.length} variants</span>`
            : `<span class="pill">No variants</span>`}
        </div>
        <div class="review-variants">${variantHtml}</div>
        <div class="review-book-footer">
          <span>${variants.length} variant${variants.length !== 1 ? 's' : ''}</span>
          ${selectedJobId
            ? `<span style="color:var(--green); font-weight:600;">✓ Selected</span>`
            : `<span>Click to select</span>`}
        </div>
      </div>`;
  }).join('');

  // Attach click handlers
  grid.querySelectorAll('.review-variant').forEach(v => {
    v.addEventListener('click', () => selectVariant(v));
  });
}

function selectVariant(el) {
  const bookId = el.dataset.bookId;
  const jobId = el.dataset.jobId;

  // Deselect all in this book card
  const card = el.closest('.review-book-card');
  card.querySelectorAll('.review-variant').forEach(v => v.classList.remove('selected'));

  // Toggle: if clicking same variant, deselect
  if (selections[bookId] === jobId) {
    delete selections[bookId];
  } else {
    el.classList.add('selected');
    selections[bookId] = jobId;
  }

  // Update footer
  const footer = card.querySelector('.review-book-footer');
  const hasSelection = !!selections[bookId];
  const count = card.querySelectorAll('.review-variant').length;
  footer.innerHTML = `
    <span>${count} variant${count !== 1 ? 's' : ''}</span>
    ${hasSelection
      ? `<span style="color:var(--green); font-weight:600;">✓ Selected</span>`
      : `<span>Click to select</span>`}
  `;
}

async function saveSelections() {
  const btn = document.getElementById('save-selections-btn');
  btn.disabled = true;
  btn.textContent = 'Saving…';

  // Build selections array
  const selList = Object.entries(selections).map(([book_id, job_id]) => {
    // Find quality score
    const book = allBooks.find(b => b.id === book_id);
    const variant = book && book.variants.find(v => v.id === job_id);
    return {
      book_id,
      job_id,
      variant_index: variant ? (variant.variant || 1) : 1,
      quality_score: variant ? variant.quality_score : null,
    };
  });

  try {
    const result = await API.post('/api/save-selections', { selections: selList });
    toast(`Saved ${result.saved} selection${result.saved !== 1 ? 's' : ''}`, 'success');
    await loadReviewData();
  } catch (e) {
    toast('Failed to save: ' + e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save Selections';
  }
}

function setupEventListeners() {
  document.getElementById('filter-select').addEventListener('change', async (e) => {
    currentFilter = e.target.value;
    await loadReviewData();
  });

  document.getElementById('save-selections-btn').addEventListener('click', saveSelections);

  document.getElementById('bulk-approve-btn').addEventListener('click', () => {
    document.getElementById('bulk-modal').classList.remove('hidden');
  });

  document.getElementById('confirm-bulk-approve').addEventListener('click', async () => {
    const threshold = parseFloat(document.getElementById('threshold-input').value) || 0.6;
    try {
      const result = await API.post('/api/batch-approve', { threshold });
      toast(`Auto-approved ${result.approved} books`, 'success');
      document.getElementById('bulk-modal').classList.add('hidden');
      await loadReviewData();
    } catch (e) {
      toast('Bulk approve failed: ' + e.message, 'error');
    }
  });
}

document.addEventListener('DOMContentLoaded', init);
