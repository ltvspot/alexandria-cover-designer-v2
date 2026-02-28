/**
 * common.js — Shared utilities for Alexandria Cover Designer v2
 */

// ─── API client ────────────────────────────────────────────────────────────
const API = {
  async get(path) {
    const r = await fetch(path);
    if (!r.ok) throw new Error(`GET ${path} failed: ${r.status}`);
    return r.json();
  },
  async post(path, body) {
    const r = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const text = await r.text();
      throw new Error(`POST ${path} failed: ${r.status} — ${text}`);
    }
    return r.json();
  },
};

// ─── Formatting ────────────────────────────────────────────────────────────
function formatCost(usd) {
  if (usd === null || usd === undefined) return '—';
  if (usd < 0.001) return '<$0.001';
  return '$' + usd.toFixed(usd < 0.01 ? 4 : 3);
}

function formatDuration(ms) {
  if (!ms) return '—';
  if (ms < 1000) return `${ms}ms`;
  const s = (ms / 1000).toFixed(1);
  return `${s}s`;
}

function formatScore(score) {
  if (score === null || score === undefined) return '—';
  return Math.round(score * 100) + '%';
}

function formatElapsed(startMs) {
  const elapsed = Math.floor((Date.now() - startMs) / 1000);
  if (elapsed < 60) return `${elapsed}s`;
  const m = Math.floor(elapsed / 60), s = elapsed % 60;
  return `${m}m ${s}s`;
}

// ─── DOM helpers ───────────────────────────────────────────────────────────
function el(id) { return document.getElementById(id); }
function qs(sel, ctx = document) { return ctx.querySelector(sel); }
function qsa(sel, ctx = document) { return Array.from(ctx.querySelectorAll(sel)); }

function show(elem) { if (elem) elem.classList.remove('hidden'); }
function hide(elem) { if (elem) elem.classList.add('hidden'); }

// ─── Toast notification ────────────────────────────────────────────────────
let _toastContainer = null;

function toast(msg, type = 'info', duration = 4000) {
  if (!_toastContainer) {
    _toastContainer = document.createElement('div');
    _toastContainer.style.cssText =
      'position:fixed;bottom:24px;right:24px;z-index:9999;display:flex;flex-direction:column;gap:8px;pointer-events:none;';
    document.body.appendChild(_toastContainer);
  }
  const t = document.createElement('div');
  const colors = { info: '#1a2744', error: '#c94040', success: '#2e7d4f', warn: '#7a6030' };
  t.style.cssText = `
    background: ${colors[type] || colors.info};
    color: #fff;
    padding: 10px 16px;
    border-radius: 8px;
    font-family: Inter, sans-serif;
    font-size: 0.8125rem;
    box-shadow: 0 4px 16px rgba(0,0,0,.2);
    max-width: 340px;
    pointer-events: auto;
    opacity: 0;
    transform: translateY(10px);
    transition: all 200ms cubic-bezier(0.16,1,0.3,1);
  `;
  t.textContent = msg;
  _toastContainer.appendChild(t);
  requestAnimationFrame(() => {
    t.style.opacity = '1';
    t.style.transform = 'translateY(0)';
  });
  setTimeout(() => {
    t.style.opacity = '0';
    t.style.transform = 'translateY(8px)';
    setTimeout(() => t.remove(), 300);
  }, duration);
}

// ─── Status badge ──────────────────────────────────────────────────────────
function statusBadge(status) {
  const labels = {
    queued: 'Queued',
    running: 'Running',
    completed: 'Done',
    failed: 'Failed',
    cancelled: 'Cancelled',
  };
  const span = document.createElement('span');
  span.className = `job-status-badge status-${status}`;
  span.textContent = labels[status] || status;
  return span;
}

// ─── Download helper ────────────────────────────────────────────────────────
async function downloadJobResult(jobId, bookTitle) {
  const url = `/api/jobs/${jobId}/result-image`;
  const filename = `${bookTitle || jobId}_cover.jpg`.replace(/[^a-z0-9_.-]/gi, '_');
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error('Not ready');
    const blob = await r.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
  } catch (e) {
    toast('Download failed: ' + e.message, 'error');
  }
}

// ─── Export ─────────────────────────────────────────────────────────────────
window.API = API;
window.formatCost = formatCost;
window.formatDuration = formatDuration;
window.formatScore = formatScore;
window.formatElapsed = formatElapsed;
window.el = el;
window.qs = qs;
window.qsa = qsa;
window.show = show;
window.hide = hide;
window.toast = toast;
window.statusBadge = statusBadge;
window.downloadJobResult = downloadJobResult;
