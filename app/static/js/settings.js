/**
 * settings.js — Settings page
 */

let currentSettings = {};

async function init() {
  await loadCostBadge();
  await loadSettings();
  await loadModels();
  checkDriveStatus();
  setupEventListeners();
}

async function loadCostBadge() {
  try {
    const data = await API.get('/api/analytics/costs');
    const el = document.getElementById('cost-today');
    if (el) el.textContent = formatCost(data.today);
  } catch (e) {}
}

async function loadSettings() {
  try {
    currentSettings = await API.get('/api/settings');
    applySettingsToForm(currentSettings);
  } catch (e) {
    toast('Failed to load settings: ' + e.message, 'error');
  }
}

function applySettingsToForm(s) {
  const setVal = (id, val) => {
    const el = document.getElementById(id);
    if (el && val != null) el.value = val;
  };
  setVal('setting-budget', s.budget_limit);
  setVal('setting-auto-approve', s.auto_approve_threshold);
  setVal('setting-variants', s.default_variants);
  setVal('setting-quality-threshold', s.quality_threshold);
  setVal('setting-drive-folder', s.drive_folder_id);
  setVal('setting-medallion-cx', s.medallion_center_x);
  setVal('setting-medallion-cy', s.medallion_center_y);
  setVal('setting-medallion-r', s.medallion_radius);
}

async function loadModels() {
  try {
    const models = await API.get('/api/models');
    const sel = document.getElementById('setting-default-model');
    models.forEach(m => {
      const opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = `${m.label} ($${m.cost_per_image?.toFixed(3)}/img)`;
      if (m.id === currentSettings.default_model || m.default) opt.selected = true;
      sel.appendChild(opt);
    });
  } catch (e) {}
}

async function checkDriveStatus() {
  const statusEl = document.getElementById('drive-status-text');
  const badgeEl = document.getElementById('drive-status-badge');
  try {
    const health = await API.get('/api/health');
    // Try to infer drive status from settings
    const driveConnected = currentSettings.drive_connected;
    if (driveConnected) {
      statusEl.textContent = 'Connected to Google Drive';
      badgeEl.textContent = 'Connected';
      badgeEl.className = 'pill pill-green';
    } else {
      statusEl.textContent = 'Not connected — configure your Drive credentials in .env';
      badgeEl.textContent = 'Disconnected';
      badgeEl.className = 'pill pill-red';
    }
  } catch (e) {
    statusEl.textContent = 'Unable to check status';
    badgeEl.textContent = 'Unknown';
    badgeEl.className = 'pill';
  }
}

async function saveSettings() {
  const settings = {
    budget_limit: parseFloat(document.getElementById('setting-budget').value) || 50,
    auto_approve_threshold: parseFloat(document.getElementById('setting-auto-approve').value) || 0.75,
    default_model: document.getElementById('setting-default-model').value,
    default_variants: parseInt(document.getElementById('setting-variants').value) || 3,
    quality_threshold: parseFloat(document.getElementById('setting-quality-threshold').value) || 0.6,
    drive_folder_id: document.getElementById('setting-drive-folder').value || '',
    medallion_center_x: parseInt(document.getElementById('setting-medallion-cx').value) || 400,
    medallion_center_y: parseInt(document.getElementById('setting-medallion-cy').value) || 400,
    medallion_radius: parseInt(document.getElementById('setting-medallion-r').value) || 200,
  };

  const btn = document.getElementById('save-settings-btn');
  btn.disabled = true;
  btn.textContent = 'Saving…';

  try {
    await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings }),
    });
    currentSettings = { ...currentSettings, ...settings };
    toast('Settings saved', 'success');
  } catch (e) {
    toast('Save failed: ' + e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save All Settings';
  }
}

function exportState() {
  const state = {
    settings: currentSettings,
    exported_at: new Date().toISOString(),
    version: '2.0.0',
  };
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `alexandria-state-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

async function importState(file) {
  try {
    const text = await file.text();
    const state = JSON.parse(text);
    if (state.settings) {
      await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings: state.settings }),
      });
      await loadSettings();
      toast('State imported successfully', 'success');
    } else {
      toast('Invalid state file', 'error');
    }
  } catch (e) {
    toast('Import failed: ' + e.message, 'error');
  }
}

function setupEventListeners() {
  document.getElementById('save-settings-btn').addEventListener('click', saveSettings);

  document.getElementById('export-state-btn').addEventListener('click', exportState);

  document.getElementById('import-state-btn').addEventListener('click', () => {
    document.getElementById('import-state-file').click();
  });

  document.getElementById('import-state-file').addEventListener('change', (e) => {
    if (e.target.files[0]) importState(e.target.files[0]);
  });
}

document.addEventListener('DOMContentLoaded', init);
