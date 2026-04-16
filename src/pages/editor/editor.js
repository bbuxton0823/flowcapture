/**
 * FlowCapture SOP Editor
 * =======================
 * Full editor for reviewing, annotating, reordering, and editing captured steps.
 * Includes drag-and-drop reordering and canvas-based annotation tools.
 */

// Self-contained constants (no ES module imports for MV3 compatibility)
const MSG = {
  GET_STEPS: 'GET_STEPS', UPDATE_STEP: 'UPDATE_STEP',
  DELETE_STEP: 'DELETE_STEP', REORDER_STEPS: 'REORDER_STEPS',
  CLEAR_STEPS: 'CLEAR_STEPS',
};
const STORAGE_KEYS = {
  PROJECTS: 'flowcapture_projects',
  CURRENT_PROJECT: 'flowcapture_current_project',
};
const DB_CONFIG = { NAME: 'FlowCaptureDB', VERSION: 1, STORES: { SCREENSHOTS: 'screenshots' } };

function formatTimestamp(ts) {
  return new Date(ts).toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit'
  });
}

function generateId() {
  return crypto.randomUUID ? crypto.randomUUID() :
    'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
}

// IndexedDB helper for saving annotated screenshots
async function saveScreenshotToDB(id, dataUrl) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_CONFIG.NAME, DB_CONFIG.VERSION);
    request.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(DB_CONFIG.STORES.SCREENSHOTS))
        db.createObjectStore(DB_CONFIG.STORES.SCREENSHOTS, { keyPath: 'id' });
    };
    request.onsuccess = (e) => {
      const db = e.target.result;
      const tx = db.transaction(DB_CONFIG.STORES.SCREENSHOTS, 'readwrite');
      tx.objectStore(DB_CONFIG.STORES.SCREENSHOTS).put({ id, dataUrl, createdAt: Date.now() });
      tx.oncomplete = () => resolve();
      tx.onerror = (err) => reject(err);
    };
    request.onerror = (e) => reject(e);
  });
}

let steps = [];
let currentProject = null;
let currentAnnotationStep = null;
let annotationTool = 'highlight';
let annotationColor = '#ef4444';
let annotationHistory = [];
let isDrawing = false;
let drawStart = { x: 0, y: 0 };

// ─── Role & Approval Constants ───────────────────────────────────────

const ROLES = [
  { value: 'all',      label: 'All Staff',       color: '#6366f1' },
  { value: 'manager',  label: 'Housing Manager', color: '#0ea5e9' },
  { value: 'frontdesk',label: 'Front Desk',      color: '#10b981' },
  { value: 'finance',  label: 'Finance',         color: '#f59e0b' },
];

const NOTE_TYPES = [
  { value: 'info',     label: 'ℹ Info',     bg: '#eff6ff', border: '#93c5fd', text: '#1d4ed8' },
  { value: 'warning',  label: '⚠ Warning',  bg: '#fffbeb', border: '#fcd34d', text: '#92400e' },
  { value: 'critical', label: '🚨 Critical', bg: '#fef2f2', border: '#fca5a5', text: '#991b1b' },
  { value: 'tip',      label: '✅ Tip',      bg: '#f0fdf4', border: '#86efac', text: '#166534' },
];

const APPROVAL_STATES = [
  { value: 'draft',     label: 'Draft',      color: '#94a3b8', bg: '#f8fafc' },
  { value: 'in_review', label: 'In Review',  color: '#f59e0b', bg: '#fffbeb' },
  { value: 'approved',  label: '✓ Approved', color: '#16a34a', bg: '#f0fdf4' },
];

// ─── Project Metadata Helpers ────────────────────────────────────────

async function getProjectMeta() {
  const result = await chrome.storage.local.get(STORAGE_KEYS.CURRENT_PROJECT);
  const projectId = result[STORAGE_KEYS.CURRENT_PROJECT];
  if (!projectId) return {};
  const pr = await chrome.storage.local.get(STORAGE_KEYS.PROJECTS);
  const projects = pr[STORAGE_KEYS.PROJECTS] || [];
  return projects.find(p => p.id === projectId) || {};
}

async function saveProjectMeta(updates) {
  const result = await chrome.storage.local.get(STORAGE_KEYS.CURRENT_PROJECT);
  const projectId = result[STORAGE_KEYS.CURRENT_PROJECT];
  if (!projectId) return;
  const pr = await chrome.storage.local.get(STORAGE_KEYS.PROJECTS);
  const projects = pr[STORAGE_KEYS.PROJECTS] || [];
  const idx = projects.findIndex(p => p.id === projectId);
  if (idx !== -1) {
    Object.assign(projects[idx], updates, { updatedAt: Date.now() });
    await chrome.storage.local.set({ [STORAGE_KEYS.PROJECTS]: projects });
  }
}

const stepsContainer = document.getElementById('stepsContainer');
const emptyState = document.getElementById('emptyState');
const sopTitle = document.getElementById('sopTitle');
const annotationModal = document.getElementById('annotationModal');
const annotationCanvas = document.getElementById('annotationCanvas');
const ctx = annotationCanvas.getContext('2d');

// ─── Load Steps ──────────────────────────────────────────────────────

async function loadSteps() {
  try {
    const response = await chrome.runtime.sendMessage({ type: MSG.GET_STEPS });
    if (response?.success) {
      steps = response.steps || [];
      currentProject = response.project;
      sopTitle.value = currentProject?.name || 'Untitled SOP';
      renderSteps();
      await initApprovalBar();
    }
  } catch (err) {
    console.error('[FlowCapture] Failed to load steps:', err);
  }
}

// ─── Render Steps ────────────────────────────────────────────────────

function renderSteps() {
  // Clear existing step cards (keep empty state)
  stepsContainer.querySelectorAll('.step-card').forEach(el => el.remove());

  if (steps.length === 0) {
    emptyState.style.display = '';
    return;
  }

  emptyState.style.display = 'none';

  steps.forEach((step, index) => {
    const card = createStepCard(step, index);
    stepsContainer.appendChild(card);
  });
}

function createStepCard(step, index) {
  const card = document.createElement('div');
  card.className = 'step-card';
  card.dataset.stepId = step.id;
  card.draggable = true;

  const truncatedUrl = step.url ? new URL(step.url).hostname + new URL(step.url).pathname.substring(0, 40) : '';

  // Role badge HTML
  const roleObj = ROLES.find(r => r.value === (step.role || 'all')) || ROLES[0];
  const roleBadgeHtml = `<span class="role-badge" style="background:${roleObj.color}20;color:${roleObj.color};border-color:${roleObj.color}40">${roleObj.label}</span>`;

  // Agency notes HTML
  const notesHtml = (step.agencyNotes || []).map((note, ni) => {
    const nt = NOTE_TYPES.find(t => t.value === note.type) || NOTE_TYPES[0];
    return `<div class="agency-note" style="background:${nt.bg};border-left-color:${nt.border};color:${nt.text}" data-note-index="${ni}">
      <span class="note-label">${nt.label}</span>
      <span class="note-text">${escapeHtml(note.text)}</span>
      <button class="note-delete-btn" data-step-id="${step.id}" data-note-index="${ni}" title="Remove note">×</button>
    </div>`;
  }).join('');

  card.innerHTML = `
    <div class="step-header">
      <div class="step-number">
        <div class="drag-handle" title="Drag to reorder">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="8" y1="6" x2="16" y2="6"/><line x1="8" y1="12" x2="16" y2="12"/><line x1="8" y1="18" x2="16" y2="18"/>
          </svg>
        </div>
        <div class="step-badge">${index + 1}</div>
      </div>
      <div class="step-header-meta">
        ${roleBadgeHtml}
      </div>
      <div class="step-actions">
        <button class="step-action-btn annotate-btn" title="Annotate screenshot" data-step-id="${step.id}">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z"/>
          </svg>
        </button>
        <button class="step-action-btn add-note-btn" title="Add agency note" data-step-id="${step.id}">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/>
            <line x1="12" y1="13" x2="12" y2="17"/><line x1="10" y1="15" x2="14" y2="15"/>
          </svg>
        </button>
        <button class="step-action-btn move-up-btn" title="Move up" data-index="${index}" ${index === 0 ? 'disabled' : ''}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="18 15 12 9 6 15"/>
          </svg>
        </button>
        <button class="step-action-btn move-down-btn" title="Move down" data-index="${index}" ${index === steps.length - 1 ? 'disabled' : ''}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="6 9 12 15 18 9"/>
          </svg>
        </button>
        <button class="step-action-btn delete" title="Delete step" data-step-id="${step.id}">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/>
          </svg>
        </button>
      </div>
    </div>
    <div class="step-body">
      ${step.imageData ? `<img class="step-screenshot" src="${step.imageData}" alt="Step ${index + 1}" data-step-id="${step.id}">` : '<div style="padding:40px;text-align:center;color:#94a3b8;">No screenshot</div>'}
      <div class="step-fields">
        <input type="text" class="step-title-input" value="${escapeHtml(step.title || `Step ${index + 1}`)}" placeholder="Step title..." data-step-id="${step.id}" data-field="title">
        <textarea class="step-desc-input" placeholder="Add a description..." data-step-id="${step.id}" data-field="description">${escapeHtml(step.description || '')}</textarea>

        <!-- Role selector -->
        <div class="step-role-row">
          <label class="step-field-label">Applies to:</label>
          <div class="role-selector" data-step-id="${step.id}">
            ${ROLES.map(r => `<button class="role-pill ${(step.role||'all') === r.value ? 'active' : ''}" data-role="${r.value}" data-step-id="${step.id}" style="${(step.role||'all') === r.value ? `background:${r.color};color:#fff;border-color:${r.color}` : ''}">${r.label}</button>`).join('')}
          </div>
        </div>

        <!-- Agency notes -->
        <div class="agency-notes-section" id="notes-${step.id}">
          ${notesHtml}
        </div>

        <!-- Add note form (hidden by default) -->
        <div class="add-note-form" id="note-form-${step.id}" style="display:none">
          <select class="note-type-select" id="note-type-${step.id}">
            ${NOTE_TYPES.map(t => `<option value="${t.value}">${t.label}</option>`).join('')}
          </select>
          <textarea class="note-text-input" id="note-text-${step.id}" placeholder="HACSM note, e.g. 'Our agency requires approvals before this step'..." rows="2"></textarea>
          <div class="note-form-actions">
            <button class="btn-note-save" data-step-id="${step.id}">Add Note</button>
            <button class="btn-note-cancel" data-step-id="${step.id}">Cancel</button>
          </div>
        </div>

        <div class="step-meta">
          ${step.url ? `<a href="${step.url}" target="_blank" title="${step.url}">${truncatedUrl}</a>` : ''}
          <span>${formatTimestamp(step.timestamp)}</span>
          ${step.elementText ? `<span>Element: "${escapeHtml(step.elementText.substring(0, 50))}"</span>` : ''}
        </div>
      </div>
    </div>
  `;

  // Event listeners
  setupCardEvents(card, step, index);

  // Drag events
  card.addEventListener('dragstart', (e) => {
    card.classList.add('dragging');
    e.dataTransfer.setData('text/plain', index.toString());
    e.dataTransfer.effectAllowed = 'move';
  });
  card.addEventListener('dragend', () => card.classList.remove('dragging'));
  card.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; });
  card.addEventListener('drop', async (e) => {
    e.preventDefault();
    const fromIndex = parseInt(e.dataTransfer.getData('text/plain'));
    const toIndex = index;
    if (fromIndex !== toIndex) {
      await chrome.runtime.sendMessage({
        type: MSG.REORDER_STEPS,
        payload: { fromIndex, toIndex },
      });
      await loadSteps();
    }
  });

  return card;
}

function setupCardEvents(card, step, index) {
  // Delete
  card.querySelector('.delete').addEventListener('click', async () => {
    if (confirm(`Delete Step ${index + 1}?`)) {
      await chrome.runtime.sendMessage({ type: MSG.DELETE_STEP, payload: { id: step.id } });
      await loadSteps();
    }
  });

  // Move up/down
  const moveUp = card.querySelector('.move-up-btn');
  const moveDown = card.querySelector('.move-down-btn');

  if (moveUp && !moveUp.disabled) {
    moveUp.addEventListener('click', async () => {
      await chrome.runtime.sendMessage({
        type: MSG.REORDER_STEPS,
        payload: { fromIndex: index, toIndex: index - 1 },
      });
      await loadSteps();
    });
  }

  if (moveDown && !moveDown.disabled) {
    moveDown.addEventListener('click', async () => {
      await chrome.runtime.sendMessage({
        type: MSG.REORDER_STEPS,
        payload: { fromIndex: index, toIndex: index + 1 },
      });
      await loadSteps();
    });
  }

  // Annotate
  card.querySelector('.annotate-btn').addEventListener('click', () => {
    openAnnotation(step);
  });

  // Inline editing (title & description)
  const titleInput = card.querySelector('.step-title-input');
  const descInput = card.querySelector('.step-desc-input');

  let saveTimer;
  const saveField = (field, value) => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      chrome.runtime.sendMessage({
        type: MSG.UPDATE_STEP,
        payload: { id: step.id, updates: { [field]: value } },
      });
    }, 500);
  };

  titleInput.addEventListener('input', (e) => saveField('title', e.target.value));
  descInput.addEventListener('input', (e) => saveField('description', e.target.value));

  // ── Role pill selection ──
  card.querySelectorAll('.role-pill').forEach(pill => {
    pill.addEventListener('click', async () => {
      const roleValue = pill.dataset.role;
      const roleObj = ROLES.find(r => r.value === roleValue);
      // Update visual
      card.querySelectorAll('.role-pill').forEach(p => {
        p.classList.remove('active');
        p.style.background = '';
        p.style.color = '';
        p.style.borderColor = '';
      });
      pill.classList.add('active');
      pill.style.background = roleObj.color;
      pill.style.color = '#fff';
      pill.style.borderColor = roleObj.color;
      // Update role badge in header
      const badge = card.querySelector('.role-badge');
      if (badge) {
        badge.textContent = roleObj.label;
        badge.style.background = roleObj.color + '20';
        badge.style.color = roleObj.color;
        badge.style.borderColor = roleObj.color + '40';
      }
      // Save to step
      await chrome.runtime.sendMessage({
        type: MSG.UPDATE_STEP,
        payload: { id: step.id, updates: { role: roleValue } },
      });
      const stepObj = steps.find(s => s.id === step.id);
      if (stepObj) stepObj.role = roleValue;
    });
  });

  // ── Add note button — toggle form ──
  const addNoteBtn = card.querySelector('.add-note-btn');
  const noteForm = card.querySelector(`#note-form-${step.id}`);
  if (addNoteBtn && noteForm) {
    addNoteBtn.addEventListener('click', () => {
      noteForm.style.display = noteForm.style.display === 'none' ? '' : 'none';
    });
  }

  // ── Save note ──
  const saveNoteBtn = card.querySelector('.btn-note-save');
  if (saveNoteBtn) {
    saveNoteBtn.addEventListener('click', async () => {
      const typeSelect = card.querySelector(`#note-type-${step.id}`);
      const textInput = card.querySelector(`#note-text-${step.id}`);
      const text = textInput?.value?.trim();
      if (!text) return;

      const newNote = { type: typeSelect.value, text };
      const stepObj = steps.find(s => s.id === step.id);
      if (stepObj) {
        stepObj.agencyNotes = [...(stepObj.agencyNotes || []), newNote];
        await chrome.runtime.sendMessage({
          type: MSG.UPDATE_STEP,
          payload: { id: step.id, updates: { agencyNotes: stepObj.agencyNotes } },
        });
        textInput.value = '';
        noteForm.style.display = 'none';
        // Re-render just the notes section
        const notesSection = card.querySelector(`#notes-${step.id}`);
        if (notesSection) notesSection.innerHTML = renderNotesHtml(stepObj, step.id);
        attachNoteDeleteHandlers(card, step);
      }
    });
  }

  const cancelNoteBtn = card.querySelector('.btn-note-cancel');
  if (cancelNoteBtn) {
    cancelNoteBtn.addEventListener('click', () => {
      if (noteForm) noteForm.style.display = 'none';
    });
  }

  attachNoteDeleteHandlers(card, step);
}

function renderNotesHtml(step, stepId) {
  return (step.agencyNotes || []).map((note, ni) => {
    const nt = NOTE_TYPES.find(t => t.value === note.type) || NOTE_TYPES[0];
    return `<div class="agency-note" style="background:${nt.bg};border-left-color:${nt.border};color:${nt.text}" data-note-index="${ni}">
      <span class="note-label">${nt.label}</span>
      <span class="note-text">${escapeHtml(note.text)}</span>
      <button class="note-delete-btn" data-step-id="${stepId}" data-note-index="${ni}" title="Remove note">×</button>
    </div>`;
  }).join('');
}

function attachNoteDeleteHandlers(card, step) {
  card.querySelectorAll('.note-delete-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const noteIdx = parseInt(btn.dataset.noteIndex);
      const stepObj = steps.find(s => s.id === step.id);
      if (stepObj) {
        stepObj.agencyNotes = (stepObj.agencyNotes || []).filter((_, i) => i !== noteIdx);
        await chrome.runtime.sendMessage({
          type: MSG.UPDATE_STEP,
          payload: { id: step.id, updates: { agencyNotes: stepObj.agencyNotes } },
        });
        const notesSection = card.querySelector(`#notes-${step.id}`);
        if (notesSection) notesSection.innerHTML = renderNotesHtml(stepObj, step.id);
        attachNoteDeleteHandlers(card, step);
      }
    });
  });
}

// ─── Annotation System ───────────────────────────────────────────────

let baseImage = null;

function openAnnotation(step) {
  if (!step.imageData) return;
  currentAnnotationStep = step;
  annotationHistory = [];
  annotationModal.style.display = '';

  const img = new Image();
  img.onload = () => {
    const scale = Math.min(960 / img.width, 700 / img.height, 1);
    annotationCanvas.width = img.width * scale;
    annotationCanvas.height = img.height * scale;
    ctx.drawImage(img, 0, 0, annotationCanvas.width, annotationCanvas.height);
    baseImage = ctx.getImageData(0, 0, annotationCanvas.width, annotationCanvas.height);
  };
  img.src = step.imageData;
}

// Tool selection
document.querySelectorAll('.tool-btn[data-tool]').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tool-btn[data-tool]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    annotationTool = btn.dataset.tool;
  });
});

document.getElementById('annotationColor').addEventListener('input', (e) => {
  annotationColor = e.target.value;
});

// Drawing on canvas
annotationCanvas.addEventListener('mousedown', (e) => {
  isDrawing = true;
  const rect = annotationCanvas.getBoundingClientRect();
  drawStart = { x: e.clientX - rect.left, y: e.clientY - rect.top };
  // Save state for undo
  annotationHistory.push(ctx.getImageData(0, 0, annotationCanvas.width, annotationCanvas.height));
});

annotationCanvas.addEventListener('mousemove', (e) => {
  if (!isDrawing) return;
  const rect = annotationCanvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;

  // Restore to last saved state to avoid drawing trails
  if (annotationHistory.length > 0) {
    ctx.putImageData(annotationHistory[annotationHistory.length - 1], 0, 0);
  }

  ctx.strokeStyle = annotationColor;
  ctx.lineWidth = 3;

  switch (annotationTool) {
    case 'highlight':
      ctx.globalAlpha = 0.3;
      ctx.fillStyle = annotationColor;
      ctx.fillRect(
        Math.min(drawStart.x, x), Math.min(drawStart.y, y),
        Math.abs(x - drawStart.x), Math.abs(y - drawStart.y)
      );
      ctx.globalAlpha = 1;
      ctx.strokeRect(
        Math.min(drawStart.x, x), Math.min(drawStart.y, y),
        Math.abs(x - drawStart.x), Math.abs(y - drawStart.y)
      );
      break;

    case 'arrow':
      ctx.beginPath();
      ctx.moveTo(drawStart.x, drawStart.y);
      ctx.lineTo(x, y);
      ctx.stroke();
      // Arrowhead
      const angle = Math.atan2(y - drawStart.y, x - drawStart.x);
      const headLen = 15;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x - headLen * Math.cos(angle - Math.PI / 6), y - headLen * Math.sin(angle - Math.PI / 6));
      ctx.moveTo(x, y);
      ctx.lineTo(x - headLen * Math.cos(angle + Math.PI / 6), y - headLen * Math.sin(angle + Math.PI / 6));
      ctx.stroke();
      break;

    case 'blur': {
      // Gaussian blur for PII protection
      const bx = Math.round(Math.min(drawStart.x, x));
      const by = Math.round(Math.min(drawStart.y, y));
      const bw = Math.round(Math.abs(x - drawStart.x));
      const bh = Math.round(Math.abs(y - drawStart.y));
      if (bw > 2 && bh > 2) {
        applyGaussianBlur(bx, by, bw, bh, 12);
        // Draw dashed border to show blurred area
        ctx.setLineDash([4, 4]);
        ctx.strokeStyle = '#94a3b8';
        ctx.lineWidth = 1;
        ctx.strokeRect(bx, by, bw, bh);
        ctx.setLineDash([]);
      }
      break;
    }

    case 'pixelate': {
      // Pixelate for stronger PII redaction
      const px = Math.round(Math.min(drawStart.x, x));
      const py = Math.round(Math.min(drawStart.y, y));
      const pw = Math.round(Math.abs(x - drawStart.x));
      const ph = Math.round(Math.abs(y - drawStart.y));
      if (pw > 2 && ph > 2) {
        applyPixelation(px, py, pw, ph, 10);
        ctx.setLineDash([4, 4]);
        ctx.strokeStyle = '#94a3b8';
        ctx.lineWidth = 1;
        ctx.strokeRect(px, py, pw, ph);
        ctx.setLineDash([]);
      }
      break;
    }

    case 'redact': {
      // Solid black redaction bar for complete PII removal
      const rx = Math.min(drawStart.x, x);
      const ry = Math.min(drawStart.y, y);
      const rw = Math.abs(x - drawStart.x);
      const rh = Math.abs(y - drawStart.y);
      ctx.fillStyle = '#000000';
      ctx.fillRect(rx, ry, rw, rh);
      // Label
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 11px -apple-system, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('REDACTED', rx + rw / 2, ry + rh / 2 + 4);
      ctx.textAlign = 'start';
      break;
    }

    case 'text':
      ctx.font = '16px -apple-system, sans-serif';
      ctx.fillStyle = annotationColor;
      // Show a small indicator where text will be placed
      ctx.fillRect(drawStart.x - 2, drawStart.y - 2, 4, 4);
      break;
  }
});

annotationCanvas.addEventListener('mouseup', (e) => {
  if (!isDrawing) return;
  isDrawing = false;

  if (annotationTool === 'text') {
    const text = prompt('Enter annotation text:');
    if (text) {
      ctx.font = '16px -apple-system, sans-serif';
      ctx.fillStyle = annotationColor;
      ctx.fillText(text, drawStart.x, drawStart.y);
    }
  }
});

// Undo
document.getElementById('undoAnnotation').addEventListener('click', () => {
  if (annotationHistory.length > 0) {
    const prev = annotationHistory.pop();
    ctx.putImageData(prev, 0, 0);
  } else if (baseImage) {
    ctx.putImageData(baseImage, 0, 0);
  }
});

// Save annotation
document.getElementById('saveAnnotation').addEventListener('click', async () => {
  if (!currentAnnotationStep) return;
  const annotatedDataUrl = annotationCanvas.toDataURL('image/png');

  // Save back to IndexedDB
  await saveScreenshotToDB(currentAnnotationStep.id, annotatedDataUrl);

  // Update the step's imageData in our local array
  const step = steps.find(s => s.id === currentAnnotationStep.id);
  if (step) step.imageData = annotatedDataUrl;

  annotationModal.style.display = 'none';
  renderSteps();
});

// Close modal
document.getElementById('closeAnnotation').addEventListener('click', () => {
  annotationModal.style.display = 'none';
});

// ─── Top Bar Actions ─────────────────────────────────────────────────

// Export PDF
document.getElementById('exportPdfBtn').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('src/pages/export/export.html') });
});

// Generate Video
document.getElementById('generateVideoBtn').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('src/pages/video/video.html') });
});

// Export SOP
document.getElementById('exportSopBtn').addEventListener('click', async () => {
  try {
    const { filename, stepCount, sizeMB } = await SOPTransfer.downloadExport();
    alert(`Exported "${filename}" (${stepCount} steps, ${sizeMB} MB).\n\nShare this file with your team to review and edit.`);
  } catch (err) {
    alert('Export failed: ' + err.message);
  }
});

// Import SOP
document.getElementById('importSopBtn').addEventListener('click', async () => {
  const result = await SOPTransfer.promptImport();
  if (!result) return;
  if (result.error) {
    alert('Import failed: ' + result.error);
    return;
  }
  let msg = `Imported "${result.originalName}" (${result.stepCount} steps).\n\nThe SOP is now loaded and fully editable.`;
  if (result.warnings.length > 0) msg += '\n\nWarnings:\n' + result.warnings.join('\n');
  alert(msg);
  await loadSteps(); // Refresh editor
});

// Add manual step
document.getElementById('addStepBtn').addEventListener('click', async () => {
  const title = prompt('Step title:', `Step ${steps.length + 1}`);
  if (title === null) return;

  // Add step via background message (no direct storage access needed)
  const stepId = generateId();
  if (currentProject) {
    currentProject.steps.push({
      id: stepId,
      sequenceNumber: currentProject.steps.length + 1,
      title: title,
      description: '',
      url: '',
      timestamp: Date.now(),
      elementSelector: '',
      elementText: '',
      screenshotDataUrl: '',
      annotations: [],
    });
    // Save via chrome.storage directly
    const result = await chrome.storage.local.get(STORAGE_KEYS.PROJECTS);
    const projects = result[STORAGE_KEYS.PROJECTS] || [];
    const idx = projects.findIndex(p => p.id === currentProject.id);
    if (idx !== -1) {
      projects[idx] = { ...currentProject, updatedAt: Date.now() };
      await chrome.storage.local.set({ [STORAGE_KEYS.PROJECTS]: projects });
    }
  }
  await loadSteps();
});

// Save SOP title
let titleDebounce;
sopTitle.addEventListener('input', () => {
  clearTimeout(titleDebounce);
  titleDebounce = setTimeout(async () => {
    if (currentProject) {
      const result = await chrome.storage.local.get(STORAGE_KEYS.PROJECTS);
      const projects = result[STORAGE_KEYS.PROJECTS] || [];
      const idx = projects.findIndex(p => p.id === currentProject.id);
      if (idx !== -1) {
        projects[idx].name = sopTitle.value;
        projects[idx].updatedAt = Date.now();
        await chrome.storage.local.set({ [STORAGE_KEYS.PROJECTS]: projects });
      }
    }
  }, 500);
});

// ─── Helpers ─────────────────────────────────────────────────────────

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

/**
 * Apply Gaussian blur to a rectangular region of the canvas.
 * Uses a box blur approximation (3 passes) for performance.
 */
function applyGaussianBlur(x, y, w, h, radius) {
  // Clamp to canvas bounds
  x = Math.max(0, x);
  y = Math.max(0, y);
  w = Math.min(w, annotationCanvas.width - x);
  h = Math.min(h, annotationCanvas.height - y);
  if (w <= 0 || h <= 0) return;

  const imageData = ctx.getImageData(x, y, w, h);
  const pixels = imageData.data;

  // Box blur approximation (3 passes = good Gaussian approximation)
  for (let pass = 0; pass < 3; pass++) {
    boxBlurH(pixels, w, h, radius);
    boxBlurV(pixels, w, h, radius);
  }

  ctx.putImageData(imageData, x, y);
}

function boxBlurH(pixels, w, h, r) {
  const temp = new Uint8ClampedArray(pixels.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let rr = 0, gg = 0, bb = 0, aa = 0, count = 0;
      for (let ix = Math.max(0, x - r); ix <= Math.min(w - 1, x + r); ix++) {
        const idx = (y * w + ix) * 4;
        rr += pixels[idx]; gg += pixels[idx + 1]; bb += pixels[idx + 2]; aa += pixels[idx + 3];
        count++;
      }
      const idx = (y * w + x) * 4;
      temp[idx] = rr / count;
      temp[idx + 1] = gg / count;
      temp[idx + 2] = bb / count;
      temp[idx + 3] = aa / count;
    }
  }
  pixels.set(temp);
}

function boxBlurV(pixels, w, h, r) {
  const temp = new Uint8ClampedArray(pixels.length);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let rr = 0, gg = 0, bb = 0, aa = 0, count = 0;
      for (let iy = Math.max(0, y - r); iy <= Math.min(h - 1, y + r); iy++) {
        const idx = (iy * w + x) * 4;
        rr += pixels[idx]; gg += pixels[idx + 1]; bb += pixels[idx + 2]; aa += pixels[idx + 3];
        count++;
      }
      const idx = (y * w + x) * 4;
      temp[idx] = rr / count;
      temp[idx + 1] = gg / count;
      temp[idx + 2] = bb / count;
      temp[idx + 3] = aa / count;
    }
  }
  pixels.set(temp);
}

/**
 * Apply pixelation to a rectangular region — useful for stronger PII redaction.
 */
function applyPixelation(x, y, w, h, blockSize) {
  x = Math.max(0, x);
  y = Math.max(0, y);
  w = Math.min(w, annotationCanvas.width - x);
  h = Math.min(h, annotationCanvas.height - y);
  if (w <= 0 || h <= 0) return;

  const imageData = ctx.getImageData(x, y, w, h);
  const pixels = imageData.data;

  for (let by = 0; by < h; by += blockSize) {
    for (let bx = 0; bx < w; bx += blockSize) {
      // Average color in block
      let rr = 0, gg = 0, bb = 0, count = 0;
      for (let iy = by; iy < Math.min(by + blockSize, h); iy++) {
        for (let ix = bx; ix < Math.min(bx + blockSize, w); ix++) {
          const idx = (iy * w + ix) * 4;
          rr += pixels[idx]; gg += pixels[idx + 1]; bb += pixels[idx + 2];
          count++;
        }
      }
      rr = Math.round(rr / count);
      gg = Math.round(gg / count);
      bb = Math.round(bb / count);

      // Fill block with average
      for (let iy = by; iy < Math.min(by + blockSize, h); iy++) {
        for (let ix = bx; ix < Math.min(bx + blockSize, w); ix++) {
          const idx = (iy * w + ix) * 4;
          pixels[idx] = rr; pixels[idx + 1] = gg; pixels[idx + 2] = bb;
        }
      }
    }
  }

  ctx.putImageData(imageData, x, y);
}

// ─── Approval Workflow ───────────────────────────────────────────────

let currentApprovalStatus = 'draft';
let currentRoleFilter = 'all';

async function initApprovalBar() {
  const meta = await getProjectMeta();
  currentApprovalStatus = meta.approvalStatus || 'draft';
  currentRoleFilter = 'all';
  updateApprovalBarUI();
}

function updateApprovalBarUI() {
  const APPROVAL_COLORS = {
    draft:     { color: '#64748b', bg: '#f8fafc' },
    in_review: { color: '#d97706', bg: '#fffbeb' },
    approved:  { color: '#16a34a', bg: '#f0fdf4' },
  };

  document.querySelectorAll('.approval-pill').forEach(pill => {
    const isActive = pill.dataset.status === currentApprovalStatus;
    pill.classList.toggle('active', isActive);
    const c = APPROVAL_COLORS[pill.dataset.status] || APPROVAL_COLORS.draft;
    pill.style.background = isActive ? c.color : '';
    pill.style.color = isActive ? '#fff' : '';
    pill.style.borderColor = isActive ? c.color : '';
  });

  // Update topbar to show approved stamp
  const existing = document.getElementById('approvedStamp');
  if (existing) existing.remove();
  if (currentApprovalStatus === 'approved') {
    const stamp = document.createElement('span');
    stamp.id = 'approvedStamp';
    stamp.className = 'approved-stamp';
    stamp.textContent = '✓ Approved';
    document.querySelector('.topbar-left')?.appendChild(stamp);
  }
}

document.querySelectorAll('.approval-pill').forEach(pill => {
  pill.addEventListener('click', async () => {
    currentApprovalStatus = pill.dataset.status;
    await saveProjectMeta({ approvalStatus: currentApprovalStatus });
    updateApprovalBarUI();
  });
});

// ─── Role Filter ─────────────────────────────────────────────────────

document.querySelectorAll('.role-filter-pill').forEach(pill => {
  pill.addEventListener('click', () => {
    currentRoleFilter = pill.dataset.role;
    document.querySelectorAll('.role-filter-pill').forEach(p => {
      p.classList.toggle('active', p.dataset.role === currentRoleFilter);
    });
    applyRoleFilter();
  });
});

function applyRoleFilter() {
  document.querySelectorAll('.step-card').forEach(card => {
    const stepId = card.dataset.stepId;
    const step = steps.find(s => s.id === stepId);
    const stepRole = step?.role || 'all';
    const visible = currentRoleFilter === 'all' || stepRole === 'all' || stepRole === currentRoleFilter;
    card.style.display = visible ? '' : 'none';
  });
}

// ─── Google Drive Sync (Optional) ────────────────────────────────────

(async function initDriveSync() {
  if (typeof DriveSync === 'undefined') return;

  const driveSaveBtn = document.getElementById('driveSaveBtn');
  const driveOpenBtn = document.getElementById('driveOpenBtn');
  if (!driveSaveBtn || !driveOpenBtn) return;

  // Check if user is signed in — show buttons only if connected
  try {
    const signedIn = await DriveSync.isSignedIn();
    if (signedIn) {
      driveSaveBtn.style.display = '';
      driveOpenBtn.style.display = '';
    }
  } catch {
    // Not signed in — buttons stay hidden, that's fine
    return;
  }

  // Save to Drive
  driveSaveBtn.addEventListener('click', async () => {
    try {
      driveSaveBtn.disabled = true;
      driveSaveBtn.textContent = 'Saving...';
      const result = await DriveSync.saveCurrentToDrive();
      driveSaveBtn.textContent = 'Saved!';
      setTimeout(() => {
        driveSaveBtn.innerHTML = `
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4-4v2"/>
            <circle cx="9" cy="7" r="4"/>
            <path d="M23 21v-2a4 4 0 00-3-3.87"/>
            <path d="M16 3.13a4 4 0 010 7.75"/>
          </svg>
          Save to Drive`;
        driveSaveBtn.disabled = false;
      }, 2000);
    } catch (err) {
      alert('Drive save failed: ' + err.message);
      driveSaveBtn.textContent = 'Save to Drive';
      driveSaveBtn.disabled = false;
    }
  });

  // Open from Drive
  driveOpenBtn.addEventListener('click', async () => {
    try {
      driveOpenBtn.disabled = true;
      driveOpenBtn.textContent = 'Loading...';
      const files = await DriveSync.listSOPs();

      if (files.length === 0) {
        alert('No FlowCapture SOPs found on Drive.');
        driveOpenBtn.textContent = 'Open from Drive';
        driveOpenBtn.disabled = false;
        return;
      }

      // Build a simple picker
      const names = files.map((f, i) => {
        const modified = new Date(f.modifiedTime).toLocaleDateString();
        return `${i + 1}. ${f.name} (${f.modifiedBy}, ${modified})`;
      });

      const choice = prompt(
        'Choose an SOP to open:\n\n' + names.join('\n') +
        '\n\nEnter the number:'
      );

      if (choice) {
        const idx = parseInt(choice) - 1;
        if (idx >= 0 && idx < files.length) {
          await DriveSync.openFromDrive(files[idx].id);
          loadSteps(); // Reload the editor
        }
      }

      driveOpenBtn.innerHTML = `
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
        </svg>
        Open from Drive`;
      driveOpenBtn.disabled = false;
    } catch (err) {
      alert('Drive load failed: ' + err.message);
      driveOpenBtn.textContent = 'Open from Drive';
      driveOpenBtn.disabled = false;
    }
  });
})();

// ─── Initialize ──────────────────────────────────────────────────────

loadSteps();
