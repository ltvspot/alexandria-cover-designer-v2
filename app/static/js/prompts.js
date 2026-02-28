/**
 * prompts.js — Prompts management page
 */

let allPrompts = [];
let activePromptId = null;
let isNew = false;

async function init() {
  await loadCostBadge();
  await loadPrompts();
  setupEventListeners();
}

async function loadCostBadge() {
  try {
    const data = await API.get('/api/analytics/costs');
    const el = document.getElementById('cost-today');
    if (el) el.textContent = formatCost(data.today);
  } catch (e) {}
}

async function loadPrompts() {
  try {
    const category = document.getElementById('category-filter').value;
    const url = category ? `/api/prompts?category=${category}` : '/api/prompts';
    allPrompts = await API.get(url);
    renderPromptList(allPrompts);
  } catch (e) {
    toast('Failed to load prompts: ' + e.message, 'error');
  }
}

function renderPromptList(prompts) {
  const container = document.getElementById('prompt-list');
  const query = document.getElementById('prompt-search').value.toLowerCase();
  const filtered = query
    ? prompts.filter(p => (p.name || '').toLowerCase().includes(query) || (p.template || '').toLowerCase().includes(query))
    : prompts;

  if (!filtered.length) {
    container.innerHTML = '<div style="padding:20px; color:var(--text-muted); font-size:0.8rem; text-align:center;">No prompts found</div>';
    return;
  }

  container.innerHTML = filtered.map(p => `
    <div class="prompt-item ${p.id === activePromptId ? 'active' : ''}" data-id="${p.id}">
      <div class="prompt-item-name">${p.name}</div>
      <div class="prompt-item-meta">
        <span class="pill pill-navy" style="font-size:0.65rem;">${p.category}</span>
        ${p.usage_count ? `<span>Used ${p.usage_count}×</span>` : ''}
        ${p.avg_quality != null ? `<span>Avg: ${Math.round(p.avg_quality * 100)}%</span>` : ''}
      </div>
    </div>
  `).join('');

  container.querySelectorAll('.prompt-item').forEach(item => {
    item.addEventListener('click', () => selectPrompt(parseInt(item.dataset.id)));
  });
}

function selectPrompt(id) {
  activePromptId = id;
  isNew = false;
  const prompt = allPrompts.find(p => p.id === id);
  if (!prompt) return;

  renderPromptList(allPrompts);
  showEditor(prompt);
}

function showEditor(prompt) {
  const title = document.getElementById('editor-title');
  const actions = document.getElementById('editor-actions');
  const body = document.getElementById('editor-body');

  title.textContent = isNew ? 'New Prompt' : (prompt ? prompt.name : 'Prompt');
  actions.classList.remove('hidden');

  body.innerHTML = `
    <div class="form-field">
      <label>Name</label>
      <input type="text" id="field-name" value="${prompt ? escapeAttr(prompt.name) : ''}">
    </div>
    <div class="form-field">
      <label>Category</label>
      <select id="field-category">
        <option value="general" ${prompt?.category === 'general' ? 'selected' : ''}>General</option>
        <option value="style" ${prompt?.category === 'style' ? 'selected' : ''}>Style</option>
        <option value="mood" ${prompt?.category === 'mood' ? 'selected' : ''}>Mood</option>
        <option value="subject" ${prompt?.category === 'subject' ? 'selected' : ''}>Subject</option>
      </select>
    </div>
    <div class="form-field">
      <label>Template</label>
      <p style="font-size:0.7rem; color:var(--text-muted); margin-bottom:4px;">Use {title} and {author} as placeholders</p>
      <textarea id="field-template" rows="6">${prompt ? escapeHtml(prompt.template) : ''}</textarea>
    </div>
    <div class="form-field">
      <label>Negative Prompt</label>
      <textarea id="field-negative" rows="3">${prompt ? escapeHtml(prompt.negative_prompt || '') : ''}</textarea>
    </div>
    <div class="form-field">
      <label>Style Profile ID</label>
      <input type="text" id="field-style" value="${prompt ? escapeAttr(prompt.style_profile || '') : ''}" placeholder="e.g. engraving">
    </div>
    ${prompt && !isNew ? `
      <div style="padding-top:8px; border-top:1px solid var(--border); font-size:0.75rem; color:var(--text-muted);">
        Created: ${new Date(prompt.created_at).toLocaleDateString()} &nbsp;
        Updated: ${new Date(prompt.updated_at).toLocaleDateString()}
      </div>` : ''}
  `;
}

function newPrompt() {
  activePromptId = null;
  isNew = true;
  // Deselect in list
  document.querySelectorAll('.prompt-item').forEach(p => p.classList.remove('active'));
  showEditor(null);
  document.getElementById('editor-title').textContent = 'New Prompt';
}

async function savePrompt() {
  const data = {
    name: document.getElementById('field-name')?.value || '',
    category: document.getElementById('field-category')?.value || 'general',
    template: document.getElementById('field-template')?.value || '',
    negative_prompt: document.getElementById('field-negative')?.value || null,
    style_profile: document.getElementById('field-style')?.value || null,
  };

  if (!data.name || !data.template) {
    toast('Name and template are required', 'warn');
    return;
  }

  try {
    if (isNew) {
      const result = await API.post('/api/prompts', data);
      activePromptId = result.id;
      isNew = false;
      toast('Prompt created', 'success');
    } else {
      await API.post(`/api/prompts/${activePromptId}`, data);  // PUT via fetch
      const r = await fetch(`/api/prompts/${activePromptId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      toast('Prompt saved', 'success');
    }
    await loadPrompts();
  } catch (e) {
    toast('Save failed: ' + e.message, 'error');
  }
}

async function deletePrompt() {
  if (!activePromptId) return;
  if (!confirm('Delete this prompt?')) return;
  try {
    const r = await fetch(`/api/prompts/${activePromptId}`, { method: 'DELETE' });
    toast('Prompt deleted', 'success');
    activePromptId = null;
    document.getElementById('editor-body').innerHTML = `<div class="empty-state" style="padding:40px;"><p>Select or create a prompt</p></div>`;
    document.getElementById('editor-actions').classList.add('hidden');
    document.getElementById('editor-title').textContent = 'Select a prompt';
    await loadPrompts();
  } catch (e) {
    toast('Delete failed: ' + e.message, 'error');
  }
}

async function viewVersions() {
  if (!activePromptId) return;
  try {
    const versions = await API.get(`/api/prompts/${activePromptId}/versions`);
    const container = document.getElementById('versions-list');
    container.innerHTML = versions.length
      ? versions.map(v => `
          <div style="padding:10px; border-bottom:1px solid var(--border);">
            <div style="display:flex; justify-content:space-between; margin-bottom:6px;">
              <strong>Version ${v.version}</strong>
              <span style="font-size:0.75rem; color:var(--text-muted);">${new Date(v.created_at).toLocaleString()}</span>
            </div>
            <pre class="expand-prompt">${escapeHtml(v.template)}</pre>
          </div>`).join('')
      : '<div style="padding:20px; color:var(--text-muted); text-align:center;">No versions saved yet</div>';
    document.getElementById('versions-modal').classList.remove('hidden');
  } catch (e) {
    toast('Failed to load versions: ' + e.message, 'error');
  }
}

function exportPrompts() {
  const data = JSON.stringify(allPrompts, null, 2);
  const blob = new Blob([data], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'prompts.json';
  a.click();
}

async function importPrompts(file) {
  try {
    const text = await file.text();
    const prompts = JSON.parse(text);
    let imported = 0;
    for (const p of prompts) {
      try {
        await API.post('/api/prompts', {
          name: p.name,
          category: p.category || 'general',
          template: p.template,
          negative_prompt: p.negative_prompt,
          style_profile: p.style_profile,
        });
        imported++;
      } catch (e) {}
    }
    toast(`Imported ${imported} prompts`, 'success');
    await loadPrompts();
  } catch (e) {
    toast('Import failed: ' + e.message, 'error');
  }
}

function escapeHtml(s) {
  return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escapeAttr(s) {
  return (s || '').replace(/"/g, '&quot;');
}

async function seedBuiltins() {
  try {
    const result = await API.post('/api/prompts/seed-builtins', {});
    toast(`Seeded ${result.seeded} built-in prompts`, 'success');
    await loadPrompts();
  } catch (e) {
    toast('Seed failed: ' + e.message, 'error');
  }
}

function setupEventListeners() {
  document.getElementById('new-prompt-btn').addEventListener('click', newPrompt);
  document.getElementById('save-prompt-btn').addEventListener('click', savePrompt);
  document.getElementById('delete-prompt-btn').addEventListener('click', deletePrompt);
  document.getElementById('view-versions-btn').addEventListener('click', viewVersions);
  document.getElementById('export-prompts-btn').addEventListener('click', exportPrompts);
  document.getElementById('seed-builtins-btn').addEventListener('click', seedBuiltins);

  document.getElementById('import-prompts-btn').addEventListener('click', () => {
    document.getElementById('import-file').click();
  });
  document.getElementById('import-file').addEventListener('change', (e) => {
    if (e.target.files[0]) importPrompts(e.target.files[0]);
  });

  document.getElementById('prompt-search').addEventListener('input', () => renderPromptList(allPrompts));
  document.getElementById('category-filter').addEventListener('change', loadPrompts);
}

document.addEventListener('DOMContentLoaded', init);
