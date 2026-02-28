/**
 * similarity.js — Similarity matrix page
 */

async function init() {
  await loadCostBadge();
  await loadSimilarityData();
  setupEventListeners();
}

async function loadCostBadge() {
  try {
    const data = await API.get('/api/analytics/costs');
    const el = document.getElementById('cost-today');
    if (el) el.textContent = formatCost(data.today);
  } catch (e) {}
}

async function loadSimilarityData() {
  try {
    const data = await API.get('/api/similarity-matrix');
    renderAlerts(data.alert_pairs || []);
    renderHeatmap(data.jobs || [], data.pairs || []);
    renderPairsTable(data.pairs || []);
  } catch (e) {
    toast('Failed to load similarity data: ' + e.message, 'error');
  }
}

function renderAlerts(alertPairs) {
  const container = document.getElementById('alert-list');
  const countEl = document.getElementById('alert-count');
  countEl.textContent = alertPairs.length ? `(${alertPairs.length} pairs)` : '';

  if (!alertPairs.length) {
    container.innerHTML = '<div style="color:var(--text-muted); font-size:0.875rem; padding:12px;">No similar pairs detected.</div>';
    return;
  }

  container.innerHTML = alertPairs.map(p => `
    <div class="alert-pair">
      <div class="score">${(p.score * 100).toFixed(0)}%</div>
      <div>
        <span style="font-family:monospace; font-size:0.8rem;">${p.job_id_a.slice(0, 12)}…</span>
        &nbsp;↔&nbsp;
        <span style="font-family:monospace; font-size:0.8rem;">${p.job_id_b.slice(0, 12)}…</span>
      </div>
      <div style="margin-left:auto; display:flex; gap:6px;">
        <img src="/api/jobs/${p.job_id_a}/result-thumbnail" style="width:40px; height:52px; object-fit:cover; border-radius:2px; border:1px solid var(--border);" onerror="this.style.display='none'">
        <img src="/api/jobs/${p.job_id_b}/result-thumbnail" style="width:40px; height:52px; object-fit:cover; border-radius:2px; border:1px solid var(--border);" onerror="this.style.display='none'">
      </div>
    </div>
  `).join('');
}

function renderHeatmap(jobs, pairs) {
  const container = document.getElementById('heatmap-container');
  if (!jobs.length || !pairs.length) {
    container.innerHTML = '<div style="color:var(--text-muted); font-size:0.875rem; text-align:center; padding:40px;">No similarity data. Click "Compute Similarity" to analyse.</div>';
    return;
  }

  // Build score lookup
  const scoreMap = {};
  pairs.forEach(p => {
    scoreMap[`${p.job_id_a}|${p.job_id_b}`] = p.score;
    scoreMap[`${p.job_id_b}|${p.job_id_a}`] = p.score;
  });

  const displayed = jobs.slice(0, 30); // Cap at 30x30 for performance

  const html = `
    <div style="overflow:auto;">
      <table style="border-collapse:collapse;">
        <thead>
          <tr>
            <th style="padding:4px;"></th>
            ${displayed.map(j => `<th style="padding:2px; font-size:0.65rem; white-space:nowrap; transform:rotate(-45deg); display:inline-block; width:24px; height:40px; overflow:hidden;">${j.id.slice(0, 6)}</th>`).join('')}
          </tr>
        </thead>
        <tbody>
          ${displayed.map((j1, i) => `
            <tr>
              <td style="font-size:0.65rem; padding:2px 4px; white-space:nowrap; font-family:monospace;">${j1.id.slice(0, 6)}</td>
              ${displayed.map((j2, k) => {
                if (i === k) return `<td style="width:22px; height:22px; background:var(--navy); border:1px solid rgba(255,255,255,.1);" title="Same"></td>`;
                const score = scoreMap[`${j1.id}|${j2.id}`];
                if (score == null) return `<td style="width:22px; height:22px; background:var(--border);" title="Not computed"></td>`;
                const r = Math.round(score * 255);
                const g = Math.round((1 - score) * 150);
                const color = `rgb(${r},${g},50)`;
                return `<td style="width:22px; height:22px; background:${color}; border:1px solid rgba(255,255,255,.1); cursor:pointer;" title="Score: ${(score * 100).toFixed(0)}%"></td>`;
              }).join('')}
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
    <div style="margin-top:8px; font-size:0.75rem; color:var(--text-muted);">Showing ${displayed.length} of ${jobs.length} jobs</div>
  `;

  container.innerHTML = html;
}

function renderPairsTable(pairs) {
  const tbody = document.getElementById('pairs-tbody');
  if (!pairs.length) {
    tbody.innerHTML = '<tr><td colspan="4" style="text-align:center; padding:20px; color:var(--text-muted);">No pairs computed yet</td></tr>';
    return;
  }
  tbody.innerHTML = pairs.map(p => `
    <tr>
      <td><code style="font-size:0.75rem;">${p.job_id_a.slice(0, 16)}…</code></td>
      <td><code style="font-size:0.75rem;">${p.job_id_b.slice(0, 16)}…</code></td>
      <td>
        <div style="display:flex; align-items:center; gap:8px;">
          <div style="width:80px; height:5px; background:var(--border); border-radius:3px; overflow:hidden;">
            <div style="width:${(p.score * 100).toFixed(0)}%; height:100%; background:${p.score > 0.8 ? 'var(--red)' : p.score > 0.5 ? 'var(--gold)' : 'var(--green)'}; border-radius:3px;"></div>
          </div>
          <span>${(p.score * 100).toFixed(0)}%</span>
        </div>
      </td>
      <td class="muted">${p.computed_at ? new Date(p.computed_at).toLocaleDateString() : '—'}</td>
    </tr>
  `).join('');
}

function setupEventListeners() {
  document.getElementById('compute-btn').addEventListener('click', async () => {
    const btn = document.getElementById('compute-btn');
    btn.disabled = true;
    btn.textContent = '⚙ Computing…';
    try {
      await API.post('/api/similarity-compute', {});
      toast('Similarity computation started — refresh in a few seconds', 'info');
      setTimeout(async () => {
        await loadSimilarityData();
        btn.disabled = false;
        btn.textContent = '⚙ Compute Similarity';
      }, 3000);
    } catch (e) {
      toast('Compute failed: ' + e.message, 'error');
      btn.disabled = false;
      btn.textContent = '⚙ Compute Similarity';
    }
  });

  document.getElementById('refresh-btn').addEventListener('click', async () => {
    await loadSimilarityData();
    toast('Data refreshed', 'success');
  });
}

document.addEventListener('DOMContentLoaded', init);
