// settings.js — Application settings
window.Pages = window.Pages || {};
window.Pages.settings = {
  async render() {
    const content = document.getElementById('content');

    const orKey = await DB.getSetting('openrouter_key') || '';
    const gKey = await DB.getSetting('google_api_key') || '';
    const srcFolder = await DB.getSetting('drive_source_folder') || '';
    const outFolder = await DB.getSetting('drive_output_folder') || '';
    const budget = await DB.getSetting('budget_limit') || 50;
    const defVariants = await DB.getSetting('default_variant_count') || 1;
    const qualThreshold = await DB.getSetting('quality_threshold') || 0.6;
    const medCx = await DB.getSetting('medallion_cx') || 2850;
    const medCy = await DB.getSetting('medallion_cy') || 1350;
    const medR = await DB.getSetting('medallion_radius') || 520;

    content.innerHTML = `
      <div class="settings-grid">
        <div class="settings-section">
          <h3>API Keys</h3>
          <div class="card">
            <div class="form-group">
              <label class="form-label">OpenRouter API Key</label>
              <input class="form-input" type="password" id="setOrKey" value="${orKey}">
              <span class="form-hint">Used for image generation</span>
            </div>
            <div class="form-group">
              <label class="form-label">Google Cloud API Key</label>
              <input class="form-input" type="password" id="setGKey" value="${gKey}">
              <span class="form-hint">Used for Google Drive access</span>
            </div>
            <button class="btn btn-sm btn-secondary" onclick="document.getElementById('setOrKey').type = document.getElementById('setOrKey').type === 'password' ? 'text' : 'password'; document.getElementById('setGKey').type = document.getElementById('setGKey').type === 'password' ? 'text' : 'password'">
              Show/Hide Keys
            </button>
          </div>
        </div>

        <div class="settings-section">
          <h3>Google Drive</h3>
          <div class="card">
            <div class="form-group">
              <label class="form-label">Source Folder ID</label>
              <input class="form-input" id="setSrcFolder" value="${srcFolder}">
              <span class="form-hint">Folder containing book subfolders</span>
            </div>
            <div class="form-group">
              <label class="form-label">Output Folder ID</label>
              <input class="form-input" id="setOutFolder" value="${outFolder}">
              <span class="form-hint">Folder for composited covers</span>
            </div>
            <div class="flex gap-8">
              <button class="btn btn-primary btn-sm" id="syncCatalogBtn">Sync Catalog</button>
              <button class="btn btn-secondary btn-sm" id="seedPromptsBtn">Seed Built-in Prompts</button>
            </div>
          </div>
        </div>

        <div class="settings-section">
          <h3>Generation Defaults</h3>
          <div class="card">
            <div class="form-group">
              <label class="form-label">Budget Limit ($)</label>
              <input class="form-input" type="number" id="setBudget" value="${budget}" min="0" step="5">
            </div>
            <div class="form-group">
              <label class="form-label">Default Variant Count</label>
              <select class="form-select" id="setDefVariants">
                ${[1,2,3,4,5].map(n => `<option value="${n}" ${n == defVariants ? 'selected' : ''}>${n}</option>`).join('')}
              </select>
            </div>
            <div class="form-group">
              <label class="form-label">Auto-Approve Quality Threshold: <span id="threshVal">${Math.round(qualThreshold * 100)}</span>%</label>
              <input type="range" min="0" max="100" value="${Math.round(qualThreshold * 100)}" id="setQualThreshold">
            </div>
          </div>
        </div>

        <div class="settings-section">
          <h3>Medallion Position</h3>
          <div class="card">
            <div class="form-row mb-16">
              <div class="form-group">
                <label class="form-label">Center X</label>
                <input class="form-input" type="number" id="setMedCx" value="${medCx}">
              </div>
              <div class="form-group">
                <label class="form-label">Center Y</label>
                <input class="form-input" type="number" id="setMedCy" value="${medCy}">
              </div>
              <div class="form-group">
                <label class="form-label">Radius</label>
                <input class="form-input" type="number" id="setMedR" value="${medR}">
              </div>
            </div>
            <div class="medallion-preview" id="medallionPreview">
              <div class="medallion-circle" id="medallionCircle"></div>
            </div>
            <span class="form-hint mt-8" style="display:block">Cover: 3784×2777px. Default medallion at (2850, 1350) r=520</span>
          </div>
        </div>
      </div>

      <div style="margin-top:24px;display:flex;gap:8px">
        <button class="btn btn-primary" id="saveSettings">Save Settings</button>
        <button class="btn btn-danger btn-sm" id="resetSettings">Reset to Defaults</button>
      </div>
    `;

    this.updateMedallionPreview(medCx, medCy, medR);
    this.bindEvents();
  },

  updateMedallionPreview(cx, cy, r) {
    const preview = document.getElementById('medallionPreview');
    const circle = document.getElementById('medallionCircle');
    if (!preview || !circle) return;

    const scaleX = 300 / 3784;
    const scaleY = 220 / 2777;
    const scale = Math.min(scaleX, scaleY);

    const pcx = cx * scale;
    const pcy = cy * scale;
    const pr = r * scale;

    circle.style.width = `${pr * 2}px`;
    circle.style.height = `${pr * 2}px`;
    circle.style.left = `${pcx - pr}px`;
    circle.style.top = `${pcy - pr}px`;
  },

  bindEvents() {
    const slider = document.getElementById('setQualThreshold');
    slider.addEventListener('input', () => {
      document.getElementById('threshVal').textContent = slider.value;
    });

    ['setMedCx', 'setMedCy', 'setMedR'].forEach(id => {
      document.getElementById(id).addEventListener('input', () => {
        this.updateMedallionPreview(
          parseInt(document.getElementById('setMedCx').value) || 0,
          parseInt(document.getElementById('setMedCy').value) || 0,
          parseInt(document.getElementById('setMedR').value) || 0
        );
      });
    });

    document.getElementById('saveSettings').addEventListener('click', async () => {
      await DB.setSetting('openrouter_key', document.getElementById('setOrKey').value.trim());
      await DB.setSetting('google_api_key', document.getElementById('setGKey').value.trim());
      await DB.setSetting('drive_source_folder', document.getElementById('setSrcFolder').value.trim());
      await DB.setSetting('drive_output_folder', document.getElementById('setOutFolder').value.trim());
      await DB.setSetting('budget_limit', parseFloat(document.getElementById('setBudget').value) || 50);
      await DB.setSetting('default_variant_count', parseInt(document.getElementById('setDefVariants').value) || 1);
      await DB.setSetting('quality_threshold', parseInt(document.getElementById('setQualThreshold').value) / 100);
      await DB.setSetting('medallion_cx', parseInt(document.getElementById('setMedCx').value) || 2850);
      await DB.setSetting('medallion_cy', parseInt(document.getElementById('setMedCy').value) || 1350);
      await DB.setSetting('medallion_radius', parseInt(document.getElementById('setMedR').value) || 520);

      Toast.success('Settings saved');
    });

    document.getElementById('resetSettings').addEventListener('click', async () => {
      await DB.dbClear('settings');
      await DB.initDefaults();
      Toast.success('Settings reset to defaults');
      this.render();
    });

    document.getElementById('syncCatalogBtn').addEventListener('click', async () => {
      const btn = document.getElementById('syncCatalogBtn');
      btn.disabled = true;
      btn.textContent = 'Syncing...';
      try {
        const books = await Drive.syncCatalog((msg, done, total) => {
          btn.textContent = total > 0 ? `${done}/${total}` : msg;
          document.getElementById('syncStatus').textContent = total > 0 ? `${done}/${total} books` : msg;
        });
        Toast.success(`Synced ${books.length} books from Drive`);
      } catch (e) {
        Toast.error(`Sync failed: ${e.message}`);
      } finally {
        btn.disabled = false;
        btn.textContent = 'Sync Catalog';
      }
    });

    document.getElementById('seedPromptsBtn').addEventListener('click', async () => {
      const builtins = Pages.prompts._builtinPrompts;
      for (const p of builtins) {
        await DB.dbPut('prompts', { ...p, created_at: new Date().toISOString() });
      }
      Toast.success('Seeded 8 built-in prompt templates');
    });
  }
};