/**
 * mockups.js — Mockup generator page
 */

const MOCKUP_TYPES_3D = [
  { id: 'front', label: 'Standing Front', size: '2D front view' },
  { id: 'angled', label: 'Angled View', size: '3D perspective' },
  { id: 'desk', label: 'Desk Scene', size: 'Lifestyle mockup' },
  { id: 'shelf', label: 'Bookshelf', size: 'Multi-book scene' },
];

const MOCKUP_TYPES_SOCIAL = [
  { id: 'ig-square', label: 'Instagram Square', size: '1080×1080' },
  { id: 'ig-story', label: 'Instagram Story', size: '1080×1920' },
  { id: 'fb-post', label: 'Facebook Post', size: '1200×630' },
  { id: 'twitter', label: 'Twitter Card', size: '1200×675' },
];

const MOCKUP_TYPES_AMAZON = [
  { id: 'az1', label: 'Main Image', size: '2560×1600' },
  { id: 'az2', label: 'Back Cover', size: '2560×1600' },
  { id: 'az3', label: 'Author Bio', size: '2560×1600' },
  { id: 'az4', label: 'Sample Page', size: '2560×1600' },
  { id: 'az5', label: 'TOC', size: '2560×1600' },
  { id: 'az6', label: 'Lifestyle 1', size: '2560×1600' },
  { id: 'az7', label: 'Lifestyle 2', size: '2560×1600' },
];

let selectedBookId = null;
let selectedJobId = null;

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
    const books = await API.get('/api/books');
    const sel = document.getElementById('mockup-book-select');
    books.forEach(b => {
      const opt = document.createElement('option');
      opt.value = b.id;
      opt.textContent = `${b.title}${b.author ? ' — ' + b.author : ''}`;
      sel.appendChild(opt);
    });
  } catch (e) {}
}

async function onBookChange(bookId) {
  selectedBookId = bookId;
  const variantSel = document.getElementById('mockup-variant-select');
  variantSel.innerHTML = '<option value="">Loading…</option>';
  variantSel.disabled = true;
  document.getElementById('generate-mockups-btn').disabled = true;

  if (!bookId) {
    variantSel.innerHTML = '<option value="">Select book first…</option>';
    return;
  }

  try {
    const jobs = await API.get(`/api/jobs?book_id=${bookId}&status=completed&limit=20`);
    variantSel.innerHTML = '<option value="">— Select variant —</option>';
    jobs.forEach(j => {
      const opt = document.createElement('option');
      opt.value = j.id;
      const score = j.quality_score != null ? ` (${formatScore(j.quality_score)})` : '';
      opt.textContent = `V${j.variant || 1} — ${j.model}${score}`;
      variantSel.appendChild(opt);
    });
    variantSel.disabled = false;
    if (!jobs.length) {
      variantSel.innerHTML = '<option value="">No completed variants</option>';
    }
  } catch (e) {}
}

function onVariantChange(jobId) {
  selectedJobId = jobId;
  document.getElementById('generate-mockups-btn').disabled = !jobId;
}

function generateMockups() {
  if (!selectedJobId) return;
  document.getElementById('mockup-empty').classList.add('hidden');
  document.getElementById('mockup-section').classList.remove('hidden');
  document.getElementById('download-all-btn').classList.remove('hidden');

  const coverUrl = `/api/jobs/${selectedJobId}/result-thumbnail`;
  renderMockupGrid('mockup-grid-3d', MOCKUP_TYPES_3D, coverUrl);
  renderMockupGrid('mockup-grid-social', MOCKUP_TYPES_SOCIAL, coverUrl);
  renderMockupGrid('mockup-grid-amazon', MOCKUP_TYPES_AMAZON, coverUrl);
}

function renderMockupGrid(containerId, types, coverUrl) {
  const container = document.getElementById(containerId);
  container.innerHTML = types.map(t => `
    <div class="mockup-card">
      <div class="mockup-preview" style="background:linear-gradient(135deg, #1a2744 0%, #243560 100%);">
        ${renderMockupPreview(t.id, coverUrl)}
      </div>
      <div class="mockup-card-body">
        <div class="mockup-card-title">${t.label}</div>
        <div class="mockup-card-size">${t.size}</div>
        <button class="btn btn-ghost btn-sm" style="width:100%;" onclick="downloadMockup('${t.id}', '${selectedJobId}')">
          ⬇ Download
        </button>
      </div>
    </div>
  `).join('');
}

function renderMockupPreview(type, coverUrl) {
  // CSS-based mockup previews
  const style = 'position:absolute; top:50%; left:50%; transform:translate(-50%,-50%);';
  switch (type) {
    case 'front':
      return `<img src="${coverUrl}" style="${style} width:70%; height:85%; object-fit:cover; box-shadow:4px 4px 12px rgba(0,0,0,.5);" onerror="this.style.display='none'">`;
    case 'angled':
      return `<img src="${coverUrl}" style="${style} width:60%; height:80%; object-fit:cover; transform:translate(-50%,-50%) perspective(400px) rotateY(-15deg); box-shadow:8px 4px 16px rgba(0,0,0,.6);" onerror="this.style.display='none'">`;
    case 'desk':
      return `
        <div style="position:absolute; bottom:0; width:100%; height:30%; background:linear-gradient(to bottom, #4a3728, #2d1f15);"></div>
        <img src="${coverUrl}" style="${style} width:50%; height:70%; object-fit:cover; box-shadow:4px 8px 20px rgba(0,0,0,.7);" onerror="this.style.display='none'">`;
    case 'shelf':
      return `
        <div style="position:absolute; bottom:25%; width:100%; height:4px; background:#5a3a1a;"></div>
        <img src="${coverUrl}" style="${style} width:35%; height:65%; object-fit:cover; box-shadow:2px 4px 12px rgba(0,0,0,.5);" onerror="this.style.display='none'">`;
    case 'ig-square':
    case 'fb-post':
    case 'twitter':
      return `
        <div style="position:absolute; inset:0; background:rgba(197,165,90,.15); display:flex; align-items:center; justify-content:center;">
          <img src="${coverUrl}" style="height:75%; object-fit:cover; box-shadow:0 4px 20px rgba(0,0,0,.4);" onerror="this.style.display='none'">
        </div>`;
    case 'ig-story':
      return `<img src="${coverUrl}" style="${style} width:45%; height:80%; object-fit:cover; box-shadow:0 4px 20px rgba(0,0,0,.4);" onerror="this.style.display='none'">`;
    default:
      return `<img src="${coverUrl}" style="${style} width:55%; height:75%; object-fit:cover;" onerror="this.style.display='none'">`;
  }
}

async function downloadMockup(type, jobId) {
  // For now just download the result image — in production would generate actual mockup
  try {
    const r = await fetch(`/api/jobs/${jobId}/result-image`);
    if (!r.ok) throw new Error('Image not ready');
    const blob = await r.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `mockup_${type}_${jobId.slice(0, 8)}.jpg`;
    a.click();
    URL.revokeObjectURL(a.href);
  } catch (e) {
    toast('Download failed: ' + e.message, 'error');
  }
}

function setupEventListeners() {
  document.getElementById('mockup-book-select').addEventListener('change', (e) => {
    onBookChange(e.target.value);
  });

  document.getElementById('mockup-variant-select').addEventListener('change', (e) => {
    onVariantChange(e.target.value);
  });

  document.getElementById('generate-mockups-btn').addEventListener('click', generateMockups);

  document.getElementById('download-all-btn').addEventListener('click', () => {
    toast('ZIP download is a planned feature — download individual mockups for now', 'info');
  });
}

document.addEventListener('DOMContentLoaded', init);
window.downloadMockup = downloadMockup;
