/**
 * FlowCapture PDF Export Engine
 * ==============================
 * Generates formatted PDF documents from captured SOP steps using jsPDF.
 * Includes cover page, step screenshots with annotations, and metadata.
 */

// Self-contained constants
const MSG = { GET_STEPS: 'GET_STEPS' };
const STORAGE_KEYS = { PROJECTS: 'flowcapture_projects', CURRENT_PROJECT: 'flowcapture_current_project' };

// Retry on transient SW-suspension errors when messaging.js is present.
const sendMsg = (msg) =>
  (window.FlowCaptureMessaging?.sendMessageWithRetry || chrome.runtime.sendMessage.bind(chrome.runtime))(msg);

function formatTimestamp(ts) {
  return new Date(ts).toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit'
  });
}

const NOTE_TYPES = [
  { value: 'info',     label: 'INFO',     r: 29,  g: 78,  b: 216  },
  { value: 'warning',  label: 'WARNING',  r: 146, g: 64,  b: 14   },
  { value: 'critical', label: 'CRITICAL', r: 153, g: 27,  b: 27   },
  { value: 'tip',      label: 'TIP',      r: 22,  g: 101, b: 52   },
];

const NOTE_BG = {
  info:     [239, 246, 255],
  warning:  [255, 251, 235],
  critical: [254, 242, 242],
  tip:      [240, 253, 244],
};

const ROLES = [
  { value: 'all',       label: 'All Staff' },
  { value: 'manager',   label: 'Housing Manager' },
  { value: 'frontdesk', label: 'Front Desk' },
  { value: 'finance',   label: 'Finance' },
];

const { jsPDF } = window.jspdf;

let steps = [];
let projectName = 'Untitled SOP';
let approvalStatus = 'draft';

// ─── DOM Elements ────────────────────────────────────────────────────

const previewContainer = document.getElementById('previewContainer');
const loading = document.getElementById('loading');
const downloadBtn = document.getElementById('downloadPdf');
const backBtn = document.getElementById('backToEditor');

const includeUrls = document.getElementById('includeUrls');
const includeTimestamps = document.getElementById('includeTimestamps');
const includeNumbers = document.getElementById('includeNumbers');
const includeHeader = document.getElementById('includeHeader');
const pageSize = document.getElementById('pageSize');
const orientation = document.getElementById('orientation');

// ─── Load Data ───────────────────────────────────────────────────────

async function loadData() {
  try {
    const response = await sendMsg({ type: MSG.GET_STEPS });
    if (response?.success) {
      steps = response.steps || [];
      projectName = response.project?.name || 'Untitled SOP';

      // Load approval status from project metadata
      const cp = await chrome.storage.local.get(STORAGE_KEYS.CURRENT_PROJECT);
      const pr = await chrome.storage.local.get(STORAGE_KEYS.PROJECTS);
      const projects = pr[STORAGE_KEYS.PROJECTS] || [];
      const proj = projects.find(p => p.id === cp[STORAGE_KEYS.CURRENT_PROJECT]);
      approvalStatus = proj?.approvalStatus || 'draft';

      renderPreview();
    }
  } catch (err) {
    console.error('[FlowCapture] Failed to load steps:', err);
    loading.innerHTML = '<p style="color:#ef4444">Failed to load steps. Please try again.</p>';
  }
}

// ─── Render HTML Preview ─────────────────────────────────────────────

function renderPreview() {
  loading.style.display = 'none';

  if (steps.length === 0) {
    previewContainer.innerHTML = '<p style="color:white;padding:40px;">No steps to export.</p>';
    return;
  }

  const roleFilter = document.getElementById('roleFilter')?.value || 'all';
  const includeAgencyNotes = document.getElementById('includeAgencyNotes');
  const includeRoleBadge = document.getElementById('includeRoleBadge');

  // Filter steps by role
  const filteredSteps = steps.filter(s =>
    roleFilter === 'all' || (s.role || 'all') === 'all' || (s.role || 'all') === roleFilter
  );

  const approvalBadge = approvalStatus === 'approved'
    ? `<span style="display:inline-block;background:#f0fdf4;color:#16a34a;border:1px solid #86efac;padding:2px 10px;border-radius:6px;font-size:12px;font-weight:700;margin-left:8px;">✓ APPROVED</span>`
    : approvalStatus === 'in_review'
    ? `<span style="display:inline-block;background:#fffbeb;color:#d97706;border:1px solid #fcd34d;padding:2px 10px;border-radius:6px;font-size:12px;font-weight:700;margin-left:8px;">IN REVIEW</span>`
    : `<span style="display:inline-block;background:#f8fafc;color:#64748b;border:1px solid #e2e8f0;padding:2px 10px;border-radius:6px;font-size:12px;font-weight:700;margin-left:8px;">DRAFT</span>`;

  const roleLine = roleFilter !== 'all'
    ? `<p style="font-size:12px;color:#6366f1;margin-top:4px;">Audience: ${ROLES.find(r => r.value === roleFilter)?.label || 'All Staff'}</p>`
    : '';

  // Cover page
  let html = `
    <div class="preview-page">
      <div style="display:flex;align-items:center;flex-wrap:wrap;gap:8px;">
        <h2 style="margin:0">${escapeHtml(projectName)}</h2>
        ${approvalBadge}
      </div>
      <p class="subtitle">Standard Operating Procedure | ${filteredSteps.length} Steps | Generated ${new Date().toLocaleDateString()} | Housing Authority of the County of San Mateo (HACSM)</p>
      ${roleLine}
      <hr style="border:none;border-top:2px solid #6366f1;margin:16px 0;">
  `;

  // Steps
  filteredSteps.forEach((step, i) => {
    const roleObj = ROLES.find(r => r.value === (step.role || 'all')) || ROLES[0];
    const notesHtml = (includeAgencyNotes?.checked && step.agencyNotes?.length)
      ? step.agencyNotes.map(note => {
          const nt = NOTE_TYPES.find(t => t.value === note.type) || NOTE_TYPES[0];
          const bg = NOTE_BG[note.type] || NOTE_BG.info;
          return `<div style="background:rgb(${bg.join(',')});border-left:3px solid rgb(${nt.r},${nt.g},${nt.b});color:rgb(${nt.r},${nt.g},${nt.b});padding:6px 10px;margin:6px 0;border-radius:0 4px 4px 0;font-size:12px;">
            <strong>${nt.label} (HACSM):</strong> ${escapeHtml(note.text)}
          </div>`;
        }).join('')
      : '';

    html += `
      <div class="preview-step">
        <div class="preview-step-header">
          ${includeNumbers.checked ? `<div class="preview-step-num">${i + 1}</div>` : ''}
          <div class="preview-step-title">${escapeHtml(step.title || `Step ${i + 1}`)}</div>
          ${includeRoleBadge?.checked ? `<span style="font-size:11px;color:#6366f1;background:#eef2ff;border:1px solid #c7d2fe;padding:1px 8px;border-radius:10px;white-space:nowrap;">${roleObj.label}</span>` : ''}
        </div>
        ${step.imageData ? `<img src="${step.imageData}" alt="Step ${i + 1}">` : ''}
        ${step.description ? `<p class="preview-step-desc">${escapeHtml(step.description)}</p>` : ''}
        ${notesHtml}
        <div class="preview-step-meta">
          ${includeUrls.checked && step.url ? `URL: ${escapeHtml(step.url)}` : ''}
          ${includeTimestamps.checked ? ` | ${formatTimestamp(step.timestamp)}` : ''}
        </div>
      </div>
    `;
  });

  html += '</div>';
  previewContainer.innerHTML = html;
}

// ─── Generate PDF ────────────────────────────────────────────────────

async function generatePDF() {
  const format = pageSize.value;
  const orient = orientation.value;
  const roleFilterVal = document.getElementById('roleFilter')?.value || 'all';
  const showNotes = document.getElementById('includeAgencyNotes')?.checked;
  const showRoleBadge = document.getElementById('includeRoleBadge')?.checked;

  // Filter steps by role
  const exportSteps = steps.filter(s =>
    roleFilterVal === 'all' || (s.role || 'all') === 'all' || (s.role || 'all') === roleFilterVal
  );

  const doc = new jsPDF({
    orientation: orient,
    unit: 'mm',
    format: format,
  });

  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const margin = 15;
  const contentWidth = pageWidth - (margin * 2);
  let yPos = margin;

  // ── Cover Page ──
  doc.setFillColor(99, 102, 241);
  doc.rect(0, 0, pageWidth, 60, 'F');

  doc.setTextColor(255, 255, 255);
  doc.setFontSize(24);
  doc.setFont('helvetica', 'bold');
  doc.text(projectName, margin, 32);

  doc.setFontSize(11);
  doc.setFont('helvetica', 'normal');
  doc.text(`Standard Operating Procedure  ·  Housing Authority of the County of San Mateo (HACSM)`, margin, 45);

  // Approval stamp on cover
  if (approvalStatus === 'approved') {
    doc.setFillColor(22, 163, 74);
    doc.roundedRect(pageWidth - margin - 36, 6, 34, 10, 2, 2, 'F');
    doc.setTextColor(255, 255, 255);
    doc.setFontSize(8);
    doc.setFont('helvetica', 'bold');
    doc.text('✓ APPROVED', pageWidth - margin - 32, 12.5);
  } else if (approvalStatus === 'in_review') {
    doc.setFillColor(217, 119, 6);
    doc.roundedRect(pageWidth - margin - 30, 6, 28, 10, 2, 2, 'F');
    doc.setTextColor(255, 255, 255);
    doc.setFontSize(8);
    doc.setFont('helvetica', 'bold');
    doc.text('IN REVIEW', pageWidth - margin - 27, 12.5);
  }

  // Metadata below header
  yPos = 75;
  doc.setTextColor(100, 116, 139);
  doc.setFontSize(10);
  doc.text(`Steps: ${exportSteps.length}${roleFilterVal !== 'all' ? ` (${ROLES.find(r=>r.value===roleFilterVal)?.label} view)` : ''}`, margin, yPos);
  doc.text(`Generated: ${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}`, margin, yPos + 6);
  doc.text(`Created with FlowCapture`, margin, yPos + 12);

  // Divider
  yPos += 25;
  doc.setDrawColor(99, 102, 241);
  doc.setLineWidth(0.5);
  doc.line(margin, yPos, pageWidth - margin, yPos);
  yPos += 10;

  // Table of contents
  doc.setTextColor(30, 30, 46);
  doc.setFontSize(16);
  doc.setFont('helvetica', 'bold');
  doc.text('Table of Contents', margin, yPos);
  yPos += 10;

  doc.setFontSize(11);
  doc.setFont('helvetica', 'normal');
  exportSteps.forEach((step, i) => {
    if (yPos > pageHeight - 20) {
      doc.addPage();
      yPos = margin;
    }
    doc.setTextColor(99, 102, 241);
    doc.text(`${i + 1}.`, margin, yPos);
    doc.setTextColor(30, 30, 46);
    doc.text(step.title || `Step ${i + 1}`, margin + 10, yPos);
    yPos += 7;
  });

  // ── Step Pages ──
  for (let i = 0; i < exportSteps.length; i++) {
    const step = exportSteps[i];
    doc.addPage();
    yPos = margin;

    // Header bar
    if (includeHeader.checked) {
      doc.setFillColor(248, 250, 252);
      doc.rect(0, 0, pageWidth, 12, 'F');
      doc.setFontSize(8);
      doc.setTextColor(148, 163, 184);
      doc.text(projectName, margin, 8);
      doc.text(`Step ${i + 1} of ${exportSteps.length}`, pageWidth - margin - 30, 8);
      yPos = 20;
    }

    // Step number badge + title
    if (includeNumbers.checked) {
      doc.setFillColor(99, 102, 241);
      doc.roundedRect(margin, yPos - 5, 10, 10, 2, 2, 'F');
      doc.setTextColor(255, 255, 255);
      doc.setFontSize(11);
      doc.setFont('helvetica', 'bold');
      doc.text(String(i + 1), margin + 3.5, yPos + 2);
    }

    // Role badge on step title line
    const roleObj = ROLES.find(r => r.value === (step.role || 'all')) || ROLES[0];
    doc.setTextColor(30, 30, 46);
    doc.setFontSize(16);
    doc.setFont('helvetica', 'bold');
    doc.text(step.title || `Step ${i + 1}`, includeNumbers.checked ? margin + 14 : margin, yPos + 2);

    if (showRoleBadge && step.role && step.role !== 'all') {
      doc.setFontSize(8);
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(99, 102, 241);
      doc.setFillColor(238, 242, 255);
      const roleLabel = roleObj.label;
      const roleLabelW = doc.getTextWidth(roleLabel) + 4;
      doc.roundedRect(pageWidth - margin - roleLabelW, yPos - 4, roleLabelW, 7, 1.5, 1.5, 'F');
      doc.text(roleLabel, pageWidth - margin - roleLabelW + 2, yPos + 0.5);
    }
    yPos += 12;

    // Screenshot
    if (step.imageData) {
      try {
        const imgProps = doc.getImageProperties(step.imageData);
        const imgRatio = imgProps.width / imgProps.height;
        let imgWidth = contentWidth;
        let imgHeight = imgWidth / imgRatio;

        // Cap height to avoid overflow
        const maxImgHeight = pageHeight - yPos - 40;
        if (imgHeight > maxImgHeight) {
          imgHeight = maxImgHeight;
          imgWidth = imgHeight * imgRatio;
        }

        // Center image
        const imgX = margin + (contentWidth - imgWidth) / 2;

        // Border around image
        doc.setDrawColor(226, 232, 240);
        doc.setLineWidth(0.3);
        doc.rect(imgX - 1, yPos - 1, imgWidth + 2, imgHeight + 2);

        doc.addImage(step.imageData, 'PNG', imgX, yPos, imgWidth, imgHeight);
        yPos += imgHeight + 8;
      } catch (err) {
        console.warn(`[FlowCapture] Image error for step ${i + 1}:`, err);
        yPos += 5;
      }
    }

    // Description
    if (step.description) {
      doc.setTextColor(71, 85, 105);
      doc.setFontSize(11);
      doc.setFont('helvetica', 'normal');
      const descLines = doc.splitTextToSize(step.description, contentWidth);
      if (yPos + (descLines.length * 5) > pageHeight - 20) {
        doc.addPage();
        yPos = margin;
      }
      doc.text(descLines, margin, yPos);
      yPos += descLines.length * 5 + 4;
    }

    // Agency Notes / Callouts
    if (showNotes && step.agencyNotes?.length > 0) {
      for (const note of step.agencyNotes) {
        const nt = NOTE_TYPES.find(t => t.value === note.type) || NOTE_TYPES[0];
        const bg = NOTE_BG[note.type] || NOTE_BG.info;
        const noteText = `${nt.label} (HACSM): ${note.text}`;
        const noteLines = doc.splitTextToSize(noteText, contentWidth - 8);
        const noteH = noteLines.length * 5 + 6;

        if (yPos + noteH > pageHeight - 20) { doc.addPage(); yPos = margin; }

        doc.setFillColor(bg[0], bg[1], bg[2]);
        doc.roundedRect(margin, yPos, contentWidth, noteH, 1.5, 1.5, 'F');
        doc.setFillColor(nt.r, nt.g, nt.b);
        doc.rect(margin, yPos, 2.5, noteH, 'F');
        doc.setTextColor(nt.r, nt.g, nt.b);
        doc.setFontSize(9);
        doc.setFont('helvetica', 'bold');
        doc.text(`${nt.label}`, margin + 5, yPos + 4);
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(9);
        const bodyLines = doc.splitTextToSize(note.text, contentWidth - 10);
        doc.text(bodyLines, margin + 5, yPos + 9);
        yPos += noteH + 3;
      }
    }

    // Metadata
    const metaParts = [];
    if (includeUrls.checked && step.url) metaParts.push(`URL: ${step.url}`);
    if (includeTimestamps.checked) metaParts.push(`Time: ${formatTimestamp(step.timestamp)}`);
    if (step.elementText) metaParts.push(`Element: "${step.elementText.substring(0, 60)}"`);

    if (metaParts.length > 0) {
      doc.setTextColor(148, 163, 184);
      doc.setFontSize(8);
      metaParts.forEach(meta => {
        if (yPos > pageHeight - 15) {
          doc.addPage();
          yPos = margin;
        }
        const lines = doc.splitTextToSize(meta, contentWidth);
        doc.text(lines, margin, yPos);
        yPos += lines.length * 4 + 2;
      });
    }

    // Footer
    if (includeHeader.checked) {
      doc.setTextColor(148, 163, 184);
      doc.setFontSize(8);
      doc.text(`Page ${doc.internal.getNumberOfPages()}`, pageWidth / 2 - 5, pageHeight - 8);
    }
  }

  return doc;
}

// ─── Download Handler ────────────────────────────────────────────────

downloadBtn.addEventListener('click', async () => {
  downloadBtn.disabled = true;
  downloadBtn.textContent = 'Generating...';

  try {
    const doc = await generatePDF();
    const filename = `${projectName.replace(/[^a-zA-Z0-9]/g, '_')}_SOP.pdf`;
    doc.save(filename);
  } catch (err) {
    console.error('[FlowCapture] PDF generation failed:', err);
    alert('PDF generation failed. Please try again.');
  } finally {
    downloadBtn.disabled = false;
    downloadBtn.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/>
        <polyline points="7 10 12 15 17 10"/>
        <line x1="12" y1="15" x2="12" y2="3"/>
      </svg>
      Download PDF
    `;
  }
});

// ─── Option Change Handlers ──────────────────────────────────────────

const includeAgencyNotesEl = document.getElementById('includeAgencyNotes');
const includeRoleBadgeEl = document.getElementById('includeRoleBadge');
const roleFilterEl = document.getElementById('roleFilter');

[includeUrls, includeTimestamps, includeNumbers, includeHeader, pageSize, orientation,
 includeAgencyNotesEl, includeRoleBadgeEl, roleFilterEl].forEach(el => {
  if (el) el.addEventListener('change', renderPreview);
});

// ─── Navigation ──────────────────────────────────────────────────────

backBtn.addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('src/pages/editor/editor.html') });
});

// ─── Helpers ─────────────────────────────────────────────────────────

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Only allow http(s) URLs in <a href>; otherwise return "#".
// Captured step URLs could contain `javascript:` schemes if the source page
// set window.location to one — interpolating those raw would create an XSS
// vector in the exported HTML.
function sanitizeUrl(url) {
  if (!url) return '#';
  try {
    const u = new URL(url);
    return (u.protocol === 'http:' || u.protocol === 'https:') ? url : '#';
  } catch { return '#'; }
}

// ─── HTML Export ─────────────────────────────────────────────────────

async function exportHTML(steps, project) {
  const stepSections = steps.map((step, i) => {
    const imgTag = step.imageData
      ? `<img src="${step.imageData}" alt="Step ${i + 1} screenshot" class="screenshot" />`
      : '<div class="no-screenshot">No screenshot</div>';
    const urlLine = step.url
      ? `<div class="step-url"><span class="label">URL:</span> <a href="${escapeHtml(sanitizeUrl(step.url))}">${escapeHtml(step.url)}</a></div>`
      : '';
    const selectorLine = step.elementSelector
      ? `<div class="step-selector"><span class="label">Element:</span> <code>${escapeHtml(step.elementSelector)}</code></div>`
      : '';
    return `
      <section class="step" id="step-${i + 1}">
        <div class="step-header">
          <span class="step-number">Step ${i + 1}</span>
          <h2 class="step-title">${escapeHtml(step.title || '')}</h2>
        </div>
        ${step.description ? `<p class="step-description">${escapeHtml(step.description)}</p>` : ''}
        ${imgTag}
        ${urlLine}
        ${selectorLine}
      </section>`;
  }).join('\n');

  const toc = steps.map((step, i) =>
    `<li><a href="#step-${i + 1}">Step ${i + 1}: ${escapeHtml(step.title || '')}</a></li>`
  ).join('\n');

  const date = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(project.name || 'SOP')} — FlowCapture</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif; font-size: 15px; line-height: 1.6; color: #1a1a1a; background: #fff; max-width: 900px; margin: 0 auto; padding: 40px 24px; }
    h1 { font-size: 2rem; font-weight: 700; margin-bottom: 8px; }
    .meta { color: #666; font-size: 14px; margin-bottom: 32px; }
    nav { background: #f5f5f5; border-radius: 8px; padding: 20px 24px; margin-bottom: 40px; }
    nav h2 { font-size: 1rem; font-weight: 600; margin-bottom: 12px; text-transform: uppercase; letter-spacing: 0.05em; color: #666; }
    nav ol { padding-left: 20px; }
    nav li { margin-bottom: 4px; }
    nav a { color: #01696F; text-decoration: none; }
    nav a:hover { text-decoration: underline; }
    .step { border: 1px solid #e5e5e5; border-radius: 10px; padding: 24px; margin-bottom: 32px; page-break-inside: avoid; }
    .step-header { display: flex; align-items: baseline; gap: 12px; margin-bottom: 12px; }
    .step-number { background: #01696F; color: #fff; border-radius: 20px; padding: 2px 12px; font-size: 13px; font-weight: 600; white-space: nowrap; }
    .step-title { font-size: 1.1rem; font-weight: 600; }
    .step-description { color: #444; margin-bottom: 16px; }
    .screenshot { width: 100%; border: 1px solid #ddd; border-radius: 6px; margin: 12px 0; }
    .no-screenshot { background: #f5f5f5; border-radius: 6px; padding: 20px; text-align: center; color: #999; font-size: 13px; margin: 12px 0; }
    .step-url, .step-selector { font-size: 13px; color: #555; margin-top: 8px; }
    .label { font-weight: 600; margin-right: 4px; }
    code { background: #f0f0f0; padding: 2px 6px; border-radius: 4px; font-size: 12px; }
    a { color: #01696F; }
    @media print { .step { page-break-inside: avoid; } nav { page-break-after: always; } }
    .fc-toolbar { background: #f0fafa; border-bottom: 2px solid #01696F; padding: 10px 24px; margin: -40px -24px 32px -24px; }
    .fc-toolbar-inner { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px; }
    .fc-toolbar-brand { font-weight: 700; font-size: 15px; color: #01696F; display: flex; align-items: center; }
    .fc-toolbar-actions { display: flex; gap: 8px; }
    .fc-btn { padding: 7px 14px; border-radius: 6px; font-size: 13px; font-weight: 600; cursor: pointer; border: none; display: inline-flex; align-items: center; }
    .fc-btn-primary { background: #01696F; color: #fff; }
    .fc-btn-primary:hover { background: #0C4E54; }
    .fc-btn-outline { background: transparent; color: #01696F; border: 1.5px solid #01696F; }
    .fc-btn-outline:hover { background: #f0fafa; }
    .fc-toolbar-tip { font-size: 12px; color: #666; margin-top: 6px; }
    @media print { .fc-toolbar { display: none !important; } }
  </style>
</head>
<body>
  <div class="fc-toolbar" id="fc-toolbar">
    <div class="fc-toolbar-inner">
      <span class="fc-toolbar-brand">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="vertical-align:middle;margin-right:6px"><rect x="2" y="2" width="20" height="20" rx="3"/><circle cx="12" cy="12" r="3"/></svg>
        FlowCapture SOP
      </span>
      <div class="fc-toolbar-actions">
        <button onclick="window.print()" class="fc-btn fc-btn-primary">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="vertical-align:middle;margin-right:5px"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 01-2-2v-5a2 2 0 012-2h16a2 2 0 012 2v5a2 2 0 01-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>
          Print / Save as PDF
        </button>
        <button onclick="document.getElementById('fc-toolbar').style.display='none'" class="fc-btn fc-btn-outline">
          Hide toolbar
        </button>
      </div>
    </div>
    <p class="fc-toolbar-tip">Tip: In your browser's print dialog, set the destination to "Save as PDF"</p>
  </div>
  <header>
    <h1>${escapeHtml(project.name || 'SOP')}</h1>
    <p class="meta">Generated ${date} · ${steps.length} step${steps.length !== 1 ? 's' : ''} · FlowCapture</p>
  </header>
  <nav>
    <h2>Table of Contents</h2>
    <ol>${toc}</ol>
  </nav>
  <main>${stepSections}</main>
</body>
</html>`;

  return html;
}

async function downloadHTML(steps, project) {
  const html = await exportHTML(steps, project);
  const blob = new Blob([html], { type: 'text/html' });
  const url = URL.createObjectURL(blob);
  const safeName = (project.name || 'SOP').replace(/[^a-z0-9\-_ ]/gi, '_');
  await chrome.downloads.download({ url, filename: `${safeName}-SOP.html`, saveAs: false });
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// ─── HTML Download Button ────────────────────────────────────────────

const downloadHtmlBtn = document.getElementById('downloadHtml');
if (downloadHtmlBtn) {
  downloadHtmlBtn.addEventListener('click', async () => {
    downloadHtmlBtn.disabled = true;
    const originalHtml = downloadHtmlBtn.innerHTML;
    downloadHtmlBtn.textContent = 'Generating...';
    try {
      const roleFilterVal = document.getElementById('roleFilter')?.value || 'all';
      const exportSteps = steps.filter(s =>
        roleFilterVal === 'all' || (s.role || 'all') === 'all' || (s.role || 'all') === roleFilterVal
      );
      await downloadHTML(exportSteps, { name: projectName });
    } catch (err) {
      console.error('[FlowCapture] HTML generation failed:', err);
      alert('HTML generation failed: ' + (err?.message || 'Unknown'));
    } finally {
      downloadHtmlBtn.disabled = false;
      downloadHtmlBtn.innerHTML = originalHtml;
    }
  });
}

// ─── Initialize ──────────────────────────────────────────────────────

loadData();
