/**
 * FlowCapture Video Generator v3
 * ================================
 * Produces MP4-first instructional videos with:
 *   - Auto-narration from step title + description text
 *   - Chapter markers (VTT format, one chapter per step group)
 *   - Caption/subtitle generation (SRT + VTT, timed to narration)
 *   - 1080p default resolution, H.264-compatible encoding
 *   - ZIP export bundle: video.mp4 + captions.srt + captions.vtt + chapters.vtt
 *
 * Audio Tiers:
 *   Preview  — Browser TTS plays through speakers only. No audio in file.
 *   Built-in — Browser TTS + system audio capture into video.
 *   ElevenLabs — Professional AI voice, mixed directly into video.
 */

(function () {
  'use strict';

  const MSG = { GET_STEPS: 'GET_STEPS' };

  // Use the shared retry wrapper if loaded; fall back to plain sendMessage.
  const sendMsg = (msg) =>
    (window.FlowCaptureMessaging?.sendMessageWithRetry || chrome.runtime.sendMessage.bind(chrome.runtime))(msg);

  // ─── DOM Elements ────────────────────────────────────────────────

  const canvas = document.getElementById('videoCanvas');
  const ctx = canvas.getContext('2d');
  const overlay = document.getElementById('canvasOverlay');
  const progressSection = document.getElementById('progressSection');
  const progressFill = document.getElementById('progressFill');
  const progressText = document.getElementById('progressText');
  const generateBtn = document.getElementById('generateBtn');
  const previewBtn = document.getElementById('previewBtn');
  const downloadBtn = document.getElementById('downloadBtn');
  const downloadZipBtn = document.getElementById('downloadZipBtn');
  const backBtn = document.getElementById('backBtn');
  const stepsList = document.getElementById('stepsList');
  const stepCountEl = document.getElementById('stepCount');

  // Video settings
  const resolutionSelect = document.getElementById('resolution');
  const bgStyleSelect = document.getElementById('bgStyle');
  const transitionSelect = document.getElementById('transition');
  const pauseDurationSelect = document.getElementById('pauseDuration');

  // Browser TTS settings
  const ttsVoiceSelect = document.getElementById('ttsVoice');
  const ttsRateInput = document.getElementById('ttsRate');
  const ttsPitchInput = document.getElementById('ttsPitch');
  const rateLabelEl = document.getElementById('rateLabel');
  const pitchLabelEl = document.getElementById('pitchLabel');
  const browserTtsSettings = document.getElementById('browserTtsSettings');

  // ElevenLabs settings
  const elevenLabsSettings = document.getElementById('elevenLabsSettings');
  const elApiKey = document.getElementById('elApiKey');
  const elVoice = document.getElementById('elVoice');
  const elModel = document.getElementById('elModel');
  const elLoadVoices = document.getElementById('elLoadVoices');
  const elPreviewVoice = document.getElementById('elPreviewVoice');
  const elStatus = document.getElementById('elStatus');

  // Intro/Outro + Role filter
  const includeIntro = document.getElementById('includeIntro');
  const includeOutro = document.getElementById('includeOutro');
  const videoRoleFilter = document.getElementById('videoRoleFilter');

  // Format
  const outputFormatSelect = document.getElementById('outputFormat');
  const formatNote = document.getElementById('formatNote');

  let steps = [];
  let projectName = 'Untitled SOP';
  let videoBlob = null;
  let captionsSrt = '';
  let captionsVtt = '';
  let chaptersVtt = '';
  let isGenerating = false;
  let previewIndex = 0;
  let audioEngine = null;
  const mp4Converter = new MP4Converter();

  // ─── Public API on window.__flowcapture ───────────────────────────
  // Exposed so sibling scripts (e.g. video-publish.js) can access the
  // generated video blob + metadata without monkey-patching anything.
  window.__flowcapture = window.__flowcapture || {};
  window.__flowcapture.video = {
    blob: null,
    filename: null,
    format: null,
    projectName: 'Untitled SOP',
    stepCount: 0,
    captionsSrt: '',
    captionsVtt: '',
    chaptersVtt: '',
    ready: false,
    listeners: new Set(),
    onReady(cb) { this.listeners.add(cb); return () => this.listeners.delete(cb); },
    _emit() { this.listeners.forEach(cb => { try { cb(this); } catch (_) {} }); },
  };
  function publishVideoState(ready) {
    const ns = window.__flowcapture.video;
    ns.blob = videoBlob;
    ns.filename = videoBlob?._filename || null;
    ns.format = videoBlob?._format || null;
    ns.projectName = projectName;
    ns.stepCount = Array.isArray(steps) ? steps.length : 0;
    ns.captionsSrt = captionsSrt;
    ns.captionsVtt = captionsVtt;
    ns.chaptersVtt = chaptersVtt;
    ns.ready = !!ready;
    ns._emit();
  }

  // ─── Format Detection ────────────────────────────────────────────

  function checkFormatSupport() {
    const mp4Type = mp4Converter.canRecordMP4();
    if (mp4Type) {
      formatNote.textContent = '✓ Your browser supports native MP4 recording — ready for Vimeo/YouTube upload.';
      formatNote.style.color = '#10b981';
    } else {
      formatNote.textContent = 'Native MP4 not available. Will record as WebM then convert.';
      formatNote.style.color = '#f59e0b';
    }
  }
  checkFormatSupport();

  // ─── Tier Switching ──────────────────────────────────────────────

  function getSelectedTier() {
    return document.querySelector('input[name="audioTier"]:checked')?.value || 'preview';
  }

  function updateTierUI() {
    const tier = getSelectedTier();
    browserTtsSettings.style.display = (tier === 'elevenlabs') ? 'none' : '';
    elevenLabsSettings.style.display = (tier === 'elevenlabs') ? '' : 'none';
  }

  document.querySelectorAll('input[name="audioTier"]').forEach(radio => {
    radio.addEventListener('change', updateTierUI);
  });

  // ─── Browser TTS Voices ──────────────────────────────────────────

  function loadBrowserVoices() {
    const voices = speechSynthesis.getVoices();
    ttsVoiceSelect.innerHTML = '';
    voices.forEach((v, i) => {
      const opt = document.createElement('option');
      opt.value = i;
      opt.textContent = `${v.name} (${v.lang})`;
      if (v.default) opt.selected = true;
      ttsVoiceSelect.appendChild(opt);
    });
  }
  speechSynthesis.onvoiceschanged = loadBrowserVoices;
  loadBrowserVoices();

  ttsRateInput.addEventListener('input', () => { rateLabelEl.textContent = `${ttsRateInput.value}x`; });
  ttsPitchInput.addEventListener('input', () => { pitchLabelEl.textContent = ttsPitchInput.value; });

  // ─── ElevenLabs UI ───────────────────────────────────────────────
  // Unified storage: read from the same settings section as Settings page
  // (window.FlowCaptureSettings). The legacy `flowcapture_elevenlabs` key
  // is migrated on first load so existing users don't lose their key.

  (async () => {
    try {
      let saved = null;
      if (window.FlowCaptureSettings) {
        const section = await window.FlowCaptureSettings.getSection('elevenLabs');
        saved = {
          apiKey: section.apiKey || '',
          voiceId: section.defaultVoiceId || '',
          model: section.defaultModel || '',
        };
      }
      // Migrate from legacy key if unified store is empty.
      if (!saved || !saved.apiKey) {
        const legacy = await new Promise(resolve =>
          chrome.storage.local.get('flowcapture_elevenlabs', r => resolve(r.flowcapture_elevenlabs || {}))
        );
        if (legacy.apiKey && window.FlowCaptureSettings) {
          await window.FlowCaptureSettings.updateSection('elevenLabs', {
            apiKey: legacy.apiKey,
            defaultVoiceId: legacy.voiceId || '',
            defaultModel: legacy.model || 'eleven_multilingual_v2',
          });
          saved = { apiKey: legacy.apiKey, voiceId: legacy.voiceId || '', model: legacy.model || '' };
          // Remove the legacy key — we have a single source of truth now.
          chrome.storage.local.remove('flowcapture_elevenlabs');
        } else {
          saved = saved || { apiKey: '', voiceId: '', model: '' };
        }
      }
      if (saved.apiKey) elApiKey.value = saved.apiKey;
      if (saved.voiceId) elVoice.dataset.savedVoiceId = saved.voiceId;
      if (saved.model) elModel.value = saved.model;
    } catch (err) {
      console.warn('[FlowCapture:video] Failed to load ElevenLabs settings:', err);
    }
  })();

  async function saveElevenLabsConfig() {
    if (!window.FlowCaptureSettings) return;
    try {
      await window.FlowCaptureSettings.updateSection('elevenLabs', {
        apiKey: elApiKey.value.trim(),
        defaultVoiceId: elVoice.value,
        defaultModel: elModel.value,
      });
    } catch (err) {
      console.warn('[FlowCapture:video] Failed to save ElevenLabs settings:', err);
    }
  }

  elApiKey.addEventListener('change', saveElevenLabsConfig);
  elVoice.addEventListener('change', saveElevenLabsConfig);
  elModel.addEventListener('change', saveElevenLabsConfig);

  elLoadVoices.addEventListener('click', async () => {
    const key = elApiKey.value.trim();
    if (!key) {
      elStatus.textContent = 'Please enter your API key first.';
      elStatus.style.color = '#ef4444';
      return;
    }
    elStatus.textContent = 'Loading voices...';
    elStatus.style.color = '#6366f1';
    elLoadVoices.disabled = true;
    try {
      const voices = await AudioEngine.fetchElevenLabsVoices(key);
      if (voices.length === 0) {
        elStatus.textContent = 'No voices found. Check your API key.';
        elStatus.style.color = '#ef4444';
      } else {
        elVoice.innerHTML = '';
        voices.forEach(v => {
          const opt = document.createElement('option');
          opt.value = v.voice_id;
          opt.textContent = `${v.name} (${v.gender || ''} ${v.accent || ''})`.trim();
          opt.dataset.previewUrl = v.preview_url || '';
          elVoice.appendChild(opt);
        });
        if (elVoice.dataset.savedVoiceId) elVoice.value = elVoice.dataset.savedVoiceId;
        elPreviewVoice.disabled = false;
        elStatus.textContent = `${voices.length} voices loaded.`;
        elStatus.style.color = '#10b981';
        saveElevenLabsConfig();
      }
    } catch (err) {
      elStatus.textContent = `Error: ${err.message}`;
      elStatus.style.color = '#ef4444';
    } finally {
      elLoadVoices.disabled = false;
    }
  });

  elPreviewVoice.addEventListener('click', () => {
    const selectedOpt = elVoice.options[elVoice.selectedIndex];
    const previewUrl = selectedOpt?.dataset?.previewUrl;
    if (previewUrl) {
      new Audio(previewUrl).play();
    } else {
      elStatus.textContent = 'No preview available for this voice.';
    }
  });

  // ─── Audio Engine Factory ────────────────────────────────────────

  function createAudioEngine() {
    if (audioEngine) audioEngine.destroy();
    const tier = getSelectedTier();
    const config = {
      voice: parseInt(ttsVoiceSelect.value, 10) || 0,
      rate: parseFloat(ttsRateInput.value),
      pitch: parseFloat(ttsPitchInput.value),
      elevenLabsKey: elApiKey.value.trim(),
      elevenLabsVoiceId: elVoice.value,
      elevenLabsModel: elModel.value,
      onError: ({ source, message }) => {
        // Surface upstream TTS failures instead of silently falling back.
        const label = source === 'elevenlabs' ? 'ElevenLabs' : 'Browser TTS';
        console.warn(`[FlowCapture:video] ${label} error — ${message}`);
        if (elStatus && source === 'elevenlabs') {
          elStatus.textContent = `${label} failed: ${message} — using browser voice instead.`;
          elStatus.style.color = '#ef4444';
        }
      },
    };
    audioEngine = new AudioEngine(tier, config);
    return audioEngine;
  }

  // ─── Load Steps ──────────────────────────────────────────────────

  async function loadSteps() {
    try {
      const response = await sendMsg({ type: MSG.GET_STEPS });
      if (response?.success) {
        steps = response.steps || [];
        projectName = response.project?.name || 'Untitled SOP';
        stepCountEl.textContent = steps.length;
        renderStepsList();
        if (steps.length > 0) renderFrame(0);
      }
    } catch (err) {
      console.error('[FlowCapture] Failed to load steps:', err);
    }
  }

  function renderStepsList() {
    if (steps.length === 0) {
      stepsList.innerHTML = '<div class="empty-msg">No steps captured yet.</div>';
      return;
    }
    stepsList.innerHTML = steps.map((step, i) => `
      <div class="step-item" data-index="${i}">
        ${step.imageData ? `<img class="step-thumb" src="${step.imageData}" alt="Step ${i + 1}">` : '<div class="step-thumb"></div>'}
        <div class="step-info">
          <div class="step-item-title">
            <span class="step-item-badge">${i + 1}</span>
            ${escapeHtml(step.title || `Step ${i + 1}`)}
          </div>
          <textarea class="step-narration" data-index="${i}" placeholder="Narration text (auto-filled from step text)...">${escapeHtml(getNarrationText(step, i))}</textarea>
          <div class="step-duration" id="duration-${i}">Duration: estimated</div>
        </div>
      </div>
    `).join('');

    stepsList.querySelectorAll('.step-narration').forEach(ta => {
      ta.addEventListener('input', (e) => {
        steps[parseInt(e.target.dataset.index, 10)]._narration = e.target.value;
      });
    });

    stepsList.querySelectorAll('.step-item').forEach(item => {
      item.addEventListener('click', (e) => {
        if (e.target.tagName === 'TEXTAREA') return;
        previewIndex = parseInt(item.dataset.index, 10);
        renderFrame(previewIndex);
        overlay.classList.add('hidden');
      });
    });
  }

  // Auto-generate narration text from step title + description
  function getNarrationText(step, index) {
    if (step._narration !== undefined) return step._narration;
    let text = step.title || `Step ${index + 1}`;
    if (step.description && step.description !== text) {
      text += '. ' + step.description;
    }
    return text;
  }

  // ─── Caption & Chapter Generation ───────────────────────────────

  /**
   * Format milliseconds → "HH:MM:SS,mmm" (SRT) or "HH:MM:SS.mmm" (VTT)
   */
  function msToTimecode(ms, vtt = false) {
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    const ms3 = ms % 1000;
    const sep = vtt ? '.' : ',';
    return `${pad2(h)}:${pad2(m)}:${pad2(s)}${sep}${pad3(ms3)}`;
  }
  function pad2(n) { return String(n).padStart(2, '0'); }
  function pad3(n) { return String(n).padStart(3, '0'); }

  /**
   * Build SRT caption file from timed segments.
   * segments: [{startMs, endMs, text}]
   */
  function buildSRT(segments) {
    return segments.map((seg, i) => [
      String(i + 1),
      `${msToTimecode(seg.startMs, false)} --> ${msToTimecode(seg.endMs, false)}`,
      seg.text,
      ''
    ].join('\n')).join('\n');
  }

  /**
   * Build VTT caption file from timed segments.
   */
  function buildCaptionsVTT(segments) {
    const header = 'WEBVTT\nKind: captions\nLanguage: en\n\n';
    const body = segments.map((seg, i) => [
      `cue-${i + 1}`,
      `${msToTimecode(seg.startMs, true)} --> ${msToTimecode(seg.endMs, true)}`,
      seg.text,
      ''
    ].join('\n')).join('\n');
    return header + body;
  }

  /**
   * Build VTT chapters file from chapter entries.
   * chapters: [{startMs, endMs, title}]
   */
  function buildChaptersVTT(chapters) {
    const header = 'WEBVTT\nKind: chapters\n\n';
    const body = chapters.map((ch, i) => [
      `chapter-${i + 1}`,
      `${msToTimecode(ch.startMs, true)} --> ${msToTimecode(ch.endMs, true)}`,
      ch.title,
      ''
    ].join('\n')).join('\n');
    return header + body;
  }

  // ─── Canvas Rendering ────────────────────────────────────────────

  function getResolution() {
    const [w, h] = resolutionSelect.value.split('x').map(Number);
    return { width: w, height: h };
  }

  function drawBackground(w, h) {
    const style = bgStyleSelect.value;
    if (style === 'gradient') {
      const g = ctx.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, '#0f172a'); g.addColorStop(1, '#1e293b');
      ctx.fillStyle = g;
    } else if (style === 'white') {
      ctx.fillStyle = '#ffffff';
    } else {
      const g = ctx.createLinearGradient(0, 0, w, h);
      g.addColorStop(0, '#4338ca'); g.addColorStop(1, '#6366f1');
      ctx.fillStyle = g;
    }
    ctx.fillRect(0, 0, w, h);
  }

  function getTextColor() { return bgStyleSelect.value === 'white' ? '#1e1e2e' : '#ffffff'; }
  function getSubColor() { return bgStyleSelect.value === 'white' ? '#64748b' : '#94a3b8'; }

  async function renderFrame(stepIndex) {
    const { width, height } = getResolution();
    canvas.width = width; canvas.height = height;
    const step = steps[stepIndex];
    if (!step) return;

    drawBackground(width, height);
    const pad = Math.round(width * 0.03);

    // Step badge
    const bs = Math.round(height * 0.05);
    ctx.fillStyle = '#6366f1';
    roundRect(ctx, pad, pad, bs, bs, 10); ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = `bold ${Math.round(bs * 0.5)}px -apple-system, sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(String(stepIndex + 1), pad + bs / 2, pad + bs / 2);

    // Step title
    ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.fillStyle = getTextColor();
    ctx.font = `bold ${Math.round(height * 0.035)}px -apple-system, sans-serif`;
    ctx.fillText(step.title || `Step ${stepIndex + 1}`, pad + bs + 14, pad + 8);

    const imgTop = pad + bs + 20;
    const maxW = width - pad * 2;
    const maxH = height * 0.60;

    if (step.imageData) {
      const img = new Image();
      img.src = step.imageData;
      try {
        // Wait for the image to fully decode before drawing. Previously this
        // code drew synchronously and relied on a 350 ms sleep elsewhere,
        // which produced blank frames on slow machines.
        await img.decode();
      } catch (_) {
        // decode() can reject if the data URL is malformed; fall through and
        // attempt drawImage anyway so the slide still has the caption bar.
      }
      const r = img.width / img.height || 16 / 9;
      let dw = maxW, dh = dw / r;
      if (dh > maxH) { dh = maxH; dw = dh * r; }
      const ix = pad + (maxW - dw) / 2;

      ctx.shadowColor = 'rgba(0,0,0,0.35)';
      ctx.shadowBlur = 24; ctx.shadowOffsetY = 6;
      ctx.save();
      roundRect(ctx, ix, imgTop, dw, dh, 10); ctx.clip();
      ctx.drawImage(img, ix, imgTop, dw, dh);
      ctx.restore();
      ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
      ctx.strokeStyle = 'rgba(255,255,255,0.12)'; ctx.lineWidth = 1;
      roundRect(ctx, ix, imgTop, dw, dh, 10); ctx.stroke();
    }

    const capY = height - Math.round(height * 0.12);
    drawCaptionBar(getNarrationText(step, stepIndex), width, height, capY, pad);
  }

  /**
   * Draw a semi-transparent caption bar at the bottom of the frame.
   * Mimics professional subtitle styling.
   */
  function drawCaptionBar(text, w, h, y, pad) {
    if (!text) return;
    const fs = Math.round(h * 0.028);
    ctx.font = `${fs}px -apple-system, sans-serif`;
    const lines = wrapText(text, w - pad * 3, ctx);
    const barH = lines.length * fs * 1.6 + 16;
    const barY = y - barH / 2;

    // Background pill
    ctx.fillStyle = 'rgba(0,0,0,0.65)';
    roundRect(ctx, pad, barY, w - pad * 2, barH, 8);
    ctx.fill();

    // Caption text
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    lines.forEach((line, i) => {
      ctx.fillText(line, w / 2, barY + 8 + i * fs * 1.6);
    });
    ctx.textAlign = 'left';
  }

  function renderIntroSlide() {
    const { width: w, height: h } = getResolution();
    canvas.width = w; canvas.height = h;
    drawBackground(w, h);

    const ls = Math.round(h * 0.1);
    const lx = w / 2 - ls / 2, ly = h * 0.25;
    ctx.fillStyle = '#6366f1';
    roundRect(ctx, lx, ly, ls, ls, 18); ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = `bold ${Math.round(ls * 0.38)}px -apple-system, sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('FC', lx + ls / 2, ly + ls / 2);

    ctx.fillStyle = getTextColor();
    ctx.font = `bold ${Math.round(h * 0.055)}px -apple-system, sans-serif`;
    ctx.textBaseline = 'top';
    ctx.fillText(projectName, w / 2, ly + ls + 24);

    ctx.fillStyle = getSubColor();
    ctx.font = `${Math.round(h * 0.025)}px -apple-system, sans-serif`;
    ctx.fillText(`${steps.length} Steps  ·  Standard Operating Procedure`, w / 2, ly + ls + 24 + h * 0.07);

    // HACSM branding line
    ctx.font = `${Math.round(h * 0.02)}px -apple-system, sans-serif`;
    ctx.fillStyle = bgStyleSelect.value === 'white' ? '#94a3b8' : 'rgba(255,255,255,0.4)';
    ctx.fillText('Housing Authority of the County of San Mateo (HACSM)', w / 2, ly + ls + 24 + h * 0.13);
    ctx.textAlign = 'left';
  }

  function renderOutroSlide() {
    const { width: w, height: h } = getResolution();
    canvas.width = w; canvas.height = h;
    drawBackground(w, h);

    ctx.fillStyle = getTextColor();
    ctx.font = `bold ${Math.round(h * 0.05)}px -apple-system, sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('End of Procedure', w / 2, h * 0.38);

    ctx.fillStyle = getSubColor();
    ctx.font = `${Math.round(h * 0.028)}px -apple-system, sans-serif`;
    ctx.fillText(projectName, w / 2, h * 0.50);
    ctx.font = `${Math.round(h * 0.02)}px -apple-system, sans-serif`;
    ctx.fillText('Created with FlowCapture · Housing Authority of the County of San Mateo (HACSM)', w / 2, h * 0.58);
    ctx.textAlign = 'left';
  }

  // ─── Video Generation ────────────────────────────────────────────

  async function generateVideo() {
    if (isGenerating || steps.length === 0) return;
    isGenerating = true;
    generateBtn.disabled = true;
    downloadBtn.disabled = true;
    downloadZipBtn.disabled = true;
    progressSection.style.display = '';
    overlay.classList.add('hidden');

    // Reset exposed state so any sibling UI (e.g. Publish panel) hides/disables
    videoBlob = null;
    if (typeof guidanceShown !== 'undefined') guidanceShown = false;
    publishVideoState(false);

    const { width, height } = getResolution();
    canvas.width = width; canvas.height = height;
    const pauseMs = Math.max(0, parseInt(pauseDurationSelect.value, 10) || 1000);
    const transition = transitionSelect.value;
    const tier = getSelectedTier();

    // ── Timing accumulators for captions + chapters ──
    const captionSegments = [];   // [{startMs, endMs, text}]
    const chapterEntries = [];    // [{startMs, endMs, title}]
    let clock = 0;                // current video timestamp in ms

    try {
      updateProgress(0, 'Initializing audio engine...');
      const engine = createAudioEngine();
      const audioStream = engine.init();

      // ── Setup MediaRecorder ──
      const canvasStream = canvas.captureStream(30);
      const tracks = [...canvasStream.getVideoTracks()];
      if (audioStream) {
        audioStream.getAudioTracks().forEach(t => tracks.push(t));
      }

      const combinedStream = new MediaStream(tracks);
      const preferMP4 = outputFormatSelect.value === 'mp4';
      const { mimeType, isMP4, extension } = mp4Converter.getBestMimeType(preferMP4);

      updateProgress(5, `Recording as ${isMP4 ? 'MP4' : 'WebM'}...`);

      const recorder = new MediaRecorder(combinedStream, {
        mimeType,
        videoBitsPerSecond: 8000000, // 8 Mbps — sharp 1080p text
      });

      const chunks = [];
      recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
      const recordingDone = new Promise(r => { recorder.onstop = () => r(); });
      recorder.start(100);

      // ── Build slide sequence (with role filter) ──
      const roleFilter = videoRoleFilter?.value || 'all';
      const filteredSteps = steps
        .map((step, originalIndex) => ({ step, originalIndex }))
        .filter(({ step }) =>
          roleFilter === 'all' || (step.role || 'all') === 'all' || (step.role || 'all') === roleFilter
        );

      const slides = [];
      if (includeIntro.checked) {
        const audienceLabel = roleFilter !== 'all'
          ? ` · Audience: ${['Housing Manager','Front Desk','Finance','All Staff'][['manager','frontdesk','finance','all'].indexOf(roleFilter)] || 'All Staff'}`
          : '';
        slides.push({
          type: 'intro',
          narration: `${projectName}. This standard operating procedure has ${filteredSteps.length} steps.`,
          title: projectName + audienceLabel,
        });
      }
      filteredSteps.forEach(({ step, originalIndex }, i) => {
        slides.push({
          type: 'step',
          index: originalIndex,
          displayIndex: i,
          step,
          narration: getNarrationText(step, originalIndex),
          title: step.title || `Step ${i + 1}`,
        });
      });
      if (includeOutro.checked) {
        slides.push({
          type: 'outro',
          narration: `End of procedure: ${projectName}. Created with FlowCapture.`,
          title: 'End',
        });
      }

      // ── Render each slide, accumulate timing ──
      for (let s = 0; s < slides.length; s++) {
        const slide = slides[s];
        const pct = 5 + Math.round(((s + 1) / slides.length) * 88);

        // Render frame
        if (slide.type === 'intro') {
          updateProgress(pct, 'Rendering intro slide...');
          renderIntroSlide();
        } else if (slide.type === 'outro') {
          updateProgress(pct, 'Rendering outro slide...');
          renderOutroSlide();
        } else {
          updateProgress(pct, `Step ${slide.displayIndex + 1}/${filteredSteps.length} — generating narration...`);
          // renderFrame is async and resolves only after the image is fully
          // decoded — no fixed sleep needed.
          await renderFrame(slide.index);
        }

        // Record chapter start
        const chapterStartMs = clock;

        // Speak narration and capture timing
        let durationMs = 1500;
        if (slide.narration) {
          const speakStart = clock;
          durationMs = await engine.speak(slide.narration);

          // Add caption segment
          captionSegments.push({
            startMs: speakStart,
            endMs: speakStart + durationMs,
            text: slide.narration,
          });
          clock += durationMs;
        } else {
          await sleep(2000 + pauseMs);
          clock += 2000 + pauseMs;
        }

        // Pause between steps
        await sleep(pauseMs);
        clock += pauseMs;

        // Record chapter entry
        chapterEntries.push({
          startMs: chapterStartMs,
          endMs: clock,
          title: slide.title || `Step ${(slide.index || 0) + 1}`,
        });

        // Transition
        if (s < slides.length - 1 && transition !== 'none') {
          const transMs = await renderTransition(transition, width, height);
          clock += transMs;
        }
      }

      // ── Stop recording ──
      recorder.stop();
      await recordingDone;
      engine.destroy();
      // Release the canvas + audio tracks so they don't keep running in the
      // background after generation completes (memory + CPU leak otherwise).
      try { combinedStream.getTracks().forEach(t => t.stop()); } catch (_) {}
      try { canvasStream.getTracks().forEach(t => t.stop()); } catch (_) {}

      let rawBlob = new Blob(chunks, { type: mimeType });

      // ── MP4 conversion if needed ──
      if (preferMP4 && !isMP4) {
        updateProgress(94, 'Converting to MP4...');
        const result = await mp4Converter.prepareDownload(
          rawBlob, 'mp4',
          `${sanitizeFilename(projectName)}_SOP_Video.webm`
        );
        videoBlob = result.blob;
        videoBlob._filename = result.filename;
        videoBlob._format = result.format;
        if (result.conversionNeeded && !result.converted) {
          videoBlob._guidance = result.guidance;
        }
      } else {
        videoBlob = rawBlob;
        videoBlob._filename = `${sanitizeFilename(projectName)}_SOP_Video.${extension}`;
        videoBlob._format = extension;
      }

      // ── Generate caption + chapter files ──
      updateProgress(97, 'Generating captions and chapter markers...');
      captionsSrt = buildSRT(captionSegments);
      captionsVtt = buildCaptionsVTT(captionSegments);
      chaptersVtt = buildChaptersVTT(chapterEntries);

      // ── Done ──
      downloadBtn.disabled = false;
      downloadZipBtn.disabled = false;

      // Expose the finished blob + metadata for sibling scripts (video-publish.js etc.)
      publishVideoState(true);

      const sizeMB = (videoBlob.size / 1024 / 1024).toFixed(1);
      const tierLabel = tier === 'elevenlabs' ? 'ElevenLabs audio'
        : tier === 'builtin' ? 'built-in audio' : 'preview mode';
      const formatLabel = (videoBlob._format === 'mp4') ? 'MP4 ✓' : 'WebM';

      updateProgress(100, `✓ Video ready — ${sizeMB} MB · ${formatLabel} · ${captionSegments.length} captions · ${chapterEntries.length} chapters · ${tierLabel}`);

    } catch (err) {
      console.error('[FlowCapture] Video generation error:', err);
      updateProgress(0, `Error: ${err.message}`);
    } finally {
      isGenerating = false;
      generateBtn.disabled = false;
    }
  }

  async function renderTransition(type, w, h) {
    const frames = 15;
    const ft = 1000 / 30;
    const current = ctx.getImageData(0, 0, w, h);
    for (let f = 0; f < frames; f++) {
      const p = f / frames;
      if (type === 'fade') {
        ctx.putImageData(current, 0, 0);
        ctx.fillStyle = `rgba(0,0,0,${p * 0.7})`;
        ctx.fillRect(0, 0, w, h);
      } else if (type === 'slide') {
        ctx.putImageData(current, -Math.round(w * p), 0);
      }
      await sleep(ft);
    }
    return Math.round(frames * ft);
  }

  // ─── Download Handlers ───────────────────────────────────────────

  // Single video download
  let guidanceShown = false;
  downloadBtn.addEventListener('click', () => {
    if (!videoBlob) return;
    if (videoBlob._guidance && !guidanceShown) {
      alert(videoBlob._guidance);
      guidanceShown = true;
    }
    triggerDownload(videoBlob, videoBlob._filename || `${sanitizeFilename(projectName)}_SOP_Video.${videoBlob._format || 'webm'}`);
  });

  // ZIP bundle: video + SRT + VTT captions + chapters VTT
  downloadZipBtn.addEventListener('click', async () => {
    if (!videoBlob) return;

    downloadZipBtn.disabled = true;
    downloadZipBtn.textContent = 'Building ZIP...';

    try {
      const base = sanitizeFilename(projectName);
      const zipName = `${base}_SOP_Bundle.zip`;

      // We need JSZip — load it dynamically from lib if available
      if (typeof JSZip === 'undefined') {
        // Fallback: download files individually
        triggerDownload(videoBlob, `${base}_video.${videoBlob._format || 'mp4'}`);
        downloadText(captionsSrt, `${base}_captions.srt`, 'text/plain');
        downloadText(captionsVtt, `${base}_captions.vtt`, 'text/vtt');
        downloadText(chaptersVtt, `${base}_chapters.vtt`, 'text/vtt');
        downloadZipBtn.textContent = '⬇ Download Bundle (ZIP)';
        downloadZipBtn.disabled = false;
        return;
      }

      const zip = new JSZip();
      const ext = videoBlob._format || 'mp4';
      zip.file(`${base}_video.${ext}`, videoBlob);
      zip.file(`${base}_captions.srt`, captionsSrt);
      zip.file(`${base}_captions.vtt`, captionsVtt);
      zip.file(`${base}_chapters.vtt`, chaptersVtt);
      zip.file('README.txt', buildReadme(base, ext));

      const zipBlob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 3 } });
      triggerDownload(zipBlob, zipName);
    } catch (err) {
      console.error('[FlowCapture] ZIP error:', err);
      alert('ZIP creation failed. Downloading files individually instead.');
      const base = sanitizeFilename(projectName);
      triggerDownload(videoBlob, `${base}_video.${videoBlob._format || 'mp4'}`);
      downloadText(captionsSrt, `${base}_captions.srt`, 'text/plain');
      downloadText(captionsVtt, `${base}_captions.vtt`, 'text/vtt');
      downloadText(chaptersVtt, `${base}_chapters.vtt`, 'text/vtt');
    } finally {
      downloadZipBtn.textContent = '⬇ Download Bundle (ZIP)';
      downloadZipBtn.disabled = false;
    }
  });

  function triggerDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  function downloadText(content, filename, mimeType) {
    const blob = new Blob([content], { type: mimeType || 'text/plain' });
    triggerDownload(blob, filename);
  }

  function buildReadme(base, ext) {
    return [
      `FlowCapture SOP Bundle`,
      `======================`,
      `Project: ${projectName}`,
      `Generated: ${new Date().toLocaleDateString()}`,
      `Organization: Housing Authority of the County of San Mateo (HACSM)`,
      ``,
      `FILES INCLUDED`,
      `--------------`,
      `${base}_video.${ext}   — Main instructional video (upload to Vimeo/YouTube/LMS)`,
      `${base}_captions.srt  — Captions for MP4 players, YouTube, and most platforms`,
      `${base}_captions.vtt  — WebVTT captions for HTML5 video and web-based LMS`,
      `${base}_chapters.vtt  — Chapter markers for navigation (works in Vimeo/YouTube)`,
      ``,
      `HOW TO USE`,
      `----------`,
      `Vimeo:    Upload video → Add captions (.srt or .vtt) in Distribution > Subtitles`,
      `YouTube:  Upload video → Subtitles tab → Upload file (.srt)`,
      `Yardi LMS: Upload video file; link captions separately if supported`,
      `HTML5:    <video> tag with <track kind="captions" src="captions.vtt">`,
      `          <track kind="chapters" src="chapters.vtt">`,
      ``,
      `ADA NOTE: VTT captions support accessibility requirements for government training materials.`,
    ].join('\n');
  }

  // ─── Event Handlers ──────────────────────────────────────────────

  generateBtn.addEventListener('click', generateVideo);

  previewBtn.addEventListener('click', () => {
    if (steps.length === 0) return;
    overlay.classList.add('hidden');
    renderFrame(previewIndex);
    const step = steps[previewIndex];
    const u = new SpeechSynthesisUtterance(getNarrationText(step, previewIndex));
    const voices = speechSynthesis.getVoices();
    if (voices[parseInt(ttsVoiceSelect.value, 10)]) u.voice = voices[parseInt(ttsVoiceSelect.value, 10)];
    u.rate = parseFloat(ttsRateInput.value);
    speechSynthesis.speak(u);
    previewIndex = (previewIndex + 1) % steps.length;
  });

  backBtn.addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('src/pages/editor/editor.html') });
  });

  // ─── Helpers ─────────────────────────────────────────────────────

  function updateProgress(pct, text) {
    progressFill.style.width = `${pct}%`;
    progressText.textContent = text;
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  function escapeHtml(s) {
    const d = document.createElement('div');
    d.textContent = s || '';
    return d.innerHTML;
  }

  function sanitizeFilename(s) {
    return (s || 'SOP').replace(/[^a-zA-Z0-9_\-\s]/g, '').replace(/\s+/g, '_').slice(0, 60);
  }

  function wrapText(text, maxW, context) {
    const words = text.split(' ');
    const lines = [];
    let cur = '';
    words.forEach(w => {
      const test = cur ? `${cur} ${w}` : w;
      if (context.measureText(test).width > maxW && cur) {
        lines.push(cur); cur = w;
      } else { cur = test; }
    });
    if (cur) lines.push(cur);
    return lines;
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  // ─── Init ────────────────────────────────────────────────────────

  updateTierUI();
  loadSteps().then(() => maybeAutoStart());

  // Cancel any in-progress narration / audio context when the tab is closed.
  window.addEventListener('beforeunload', () => {
    try { speechSynthesis.cancel(); } catch (_) {}
    if (audioEngine) { try { audioEngine.destroy(); } catch (_) {} }
  });

  // ─── v1.6: Auto Video mode ───────────────────────────────────────
  // When opened with ?auto=1, apply sensible defaults and kick off
  // generateVideo() automatically. This is the "Snagit-style" one-click
  // workflow: screenshots → narrated video with no extra configuration.
  //
  // v1.6.1: When no ElevenLabs key is configured, show a guard modal
  // asking the user whether to Configure / Proceed with browser voice /
  // Cancel — instead of silently falling back. A "Don't ask again" flag
  // suppresses the prompt on Proceed/Configure.
  async function maybeAutoStart() {
    try {
      const params = new URLSearchParams(window.location.search);
      if (params.get('auto') !== '1') return;
      if (!steps || steps.length === 0) {
        updateProgress(0, 'No steps captured yet — capture a few steps first.');
        return;
      }

      // Apply sensible Auto defaults
      const resSel = document.getElementById('resolution');
      const bgSel = document.getElementById('bgStyle');
      const trSel = document.getElementById('transition');
      const pauseSel = document.getElementById('pauseDuration');
      const fmtSel = document.getElementById('outputFormat');
      const introChk = document.getElementById('includeIntro');
      const outroChk = document.getElementById('includeOutro');
      if (resSel) resSel.value = '1920x1080';
      if (bgSel) bgSel.value = 'gradient';
      if (trSel) trSel.value = 'fade';
      if (pauseSel) pauseSel.value = '1000';
      if (fmtSel) fmtSel.value = 'mp4';
      if (introChk) introChk.checked = true;
      if (outroChk) outroChk.checked = true;

      // Prefer ElevenLabs if a key is saved. If not, run the v1.6.1 guard
      // unless the user has previously asked us not to.
      let chose = 'builtin';
      let elevenSettings = null;
      try {
        if (window.FlowCaptureSettings) {
          const settings = await window.FlowCaptureSettings.getAll();
          elevenSettings = settings?.elevenLabs || null;
        }
      } catch (_) { /* non-fatal; treat as no key */ }

      const hasElKey = !!(elevenSettings && elevenSettings.apiKey);

      if (hasElKey) {
        chose = 'elevenlabs';
        applyElevenLabsToForm(elevenSettings);
      } else {
        const ackd = await getSilentAckFlag();
        if (!ackd) {
          const decision = await showAvModal();
          if (decision === 'cancel') {
            updateProgress(0, 'Auto Video cancelled. Configure ElevenLabs in Settings, or click Generate when ready.');
            return;
          }
          if (decision === 'configure') {
            // Open Settings in a new tab; do not start generation.
            try {
              chrome.tabs.create({ url: chrome.runtime.getURL('src/pages/settings/settings.html') });
            } catch (e) { console.warn('[FlowCapture] could not open settings tab:', e); }
            updateProgress(0, 'Opened Settings. Add your ElevenLabs key, then click Auto Video again.');
            return;
          }
          // decision === 'proceed' → fall through with browser voice
        }
        chose = 'builtin';
      }

      const radios = document.querySelectorAll('input[name="audioTier"]');
      radios.forEach(r => { r.checked = (r.value === chose); });
      if (typeof updateTierUI === 'function') updateTierUI();

      updateProgress(2, 'Auto Video: starting generation…');
      // Tiny delay so any tier UI reactions settle before we kick off.
      await sleep(120);
      generateVideo();
    } catch (err) {
      console.error('[FlowCapture] Auto Video start failed:', err);
    }
  }

  // ─── v1.6.1 helpers: silent-ack flag + guard modal ───────────────
  const SILENT_ACK_KEY = 'flowcapture_av_silent_ack';

  async function getSilentAckFlag() {
    try {
      const r = await chrome.storage.local.get(SILENT_ACK_KEY);
      return !!r[SILENT_ACK_KEY];
    } catch (_) { return false; }
  }
  async function setSilentAckFlag(v) {
    try { await chrome.storage.local.set({ [SILENT_ACK_KEY]: !!v }); }
    catch (e) { console.warn('[FlowCapture] could not persist silent-ack flag:', e); }
  }

  function applyElevenLabsToForm(elevenSettings) {
    const elKey = document.getElementById('elApiKey');
    const elVoiceSel = document.getElementById('elVoice');
    const elModelSel = document.getElementById('elModel');
    if (elKey) elKey.value = elevenSettings.apiKey;
    if (elVoiceSel && elevenSettings.defaultVoiceId) {
      const opt = document.createElement('option');
      opt.value = elevenSettings.defaultVoiceId;
      opt.textContent = elevenSettings.defaultVoiceLabel || 'Saved voice';
      opt.selected = true;
      elVoiceSel.appendChild(opt);
    }
    if (elModelSel && elevenSettings.defaultModel) {
      elModelSel.value = elevenSettings.defaultModel;
    }
  }

  // Show the guard modal; resolve with 'configure' | 'proceed' | 'cancel'.
  // Persists silent-ack on Proceed or Configure if "Don't ask again" is checked.
  // Cancel never persists the flag (Cancel = "not now", not "never").
  function showAvModal() {
    return new Promise((resolve) => {
      const overlay = document.getElementById('avModal');
      const configureBtn = document.getElementById('avConfigureBtn');
      const proceedBtn = document.getElementById('avProceedBtn');
      const cancelBtn = document.getElementById('avCancelBtn');
      const dontAsk = document.getElementById('avDontAsk');
      if (!overlay || !configureBtn || !proceedBtn || !cancelBtn || !dontAsk) {
        // Modal markup missing → fail open with the safe default (cancel).
        console.warn('[FlowCapture] guard modal markup missing; treating as cancel.');
        return resolve('cancel');
      }

      let settled = false;
      const finish = async (result) => {
        if (settled) return;
        settled = true;
        if ((result === 'proceed' || result === 'configure') && dontAsk.checked) {
          await setSilentAckFlag(true);
        }
        cleanup();
        overlay.style.display = 'none';
        resolve(result);
      };

      const onKey = (e) => { if (e.key === 'Escape') finish('cancel'); };
      const onOverlayClick = (e) => { if (e.target === overlay) finish('cancel'); };
      const onConfigure = () => finish('configure');
      const onProceed = () => finish('proceed');
      const onCancel = () => finish('cancel');

      const cleanup = () => {
        document.removeEventListener('keydown', onKey, true);
        overlay.removeEventListener('click', onOverlayClick);
        configureBtn.removeEventListener('click', onConfigure);
        proceedBtn.removeEventListener('click', onProceed);
        cancelBtn.removeEventListener('click', onCancel);
      };

      // Reset transient UI
      dontAsk.checked = false;

      document.addEventListener('keydown', onKey, true);
      overlay.addEventListener('click', onOverlayClick);
      configureBtn.addEventListener('click', onConfigure);
      proceedBtn.addEventListener('click', onProceed);
      cancelBtn.addEventListener('click', onCancel);

      overlay.style.display = 'flex';
      // Defer focus until paint so the button actually receives it.
      setTimeout(() => { try { configureBtn.focus(); } catch (_) {} }, 60);
    });
  }

})();
