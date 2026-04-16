/**
 * FlowCapture Video Publish Controller (v1.5)
 * ============================================
 * Adds "Publish to YouTube/Vimeo" buttons to the video page.
 *
 * Reads generated video + metadata from `window.__flowcapture.video`
 * which is exposed by video.js. No monkey-patching, no polling guesses.
 *
 * Contract (set by video.js):
 *   window.__flowcapture.video = {
 *     blob: Blob | null,
 *     filename, format, projectName, stepCount,
 *     captionsSrt, captionsVtt, chaptersVtt,
 *     ready: boolean,
 *     onReady(cb) -> unsubscribe()  // fires on every state change
 *   }
 */

(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const Settings = window.FlowCaptureSettings;
  const YT = window.FlowCaptureYouTube;
  const VM = window.FlowCaptureVimeo;

  document.addEventListener('DOMContentLoaded', () => {
    setupPublishUI();
    subscribeToVideoState();
    syncButtonsFromState(); // initial sync in case video.js already emitted
  });

  // ─── Wire up Publish UI ───────────────────────────────────────
  function setupPublishUI() {
    const ytBtn = $('publishYouTubeBtn');
    const vmBtn = $('publishVimeoBtn');
    const settingsLink = $('openSettingsLink');

    if (settingsLink) {
      settingsLink.addEventListener('click', (e) => {
        e.preventDefault();
        chrome.tabs.create({
          url: chrome.runtime.getURL('src/pages/settings/settings.html'),
        });
      });
    }

    if (ytBtn) ytBtn.addEventListener('click', () => publishTo('youtube'));
    if (vmBtn) vmBtn.addEventListener('click', () => publishTo('vimeo'));
  }

  // ─── Listen for video-ready events from video.js ──────────────
  function subscribeToVideoState() {
    const ns = getNamespace();
    if (!ns) {
      // video.js hasn't run yet; try again on next tick
      setTimeout(subscribeToVideoState, 50);
      return;
    }
    ns.onReady(() => syncButtonsFromState());
  }

  function getNamespace() {
    return window.__flowcapture && window.__flowcapture.video;
  }

  async function syncButtonsFromState() {
    const ns = getNamespace();
    const publishSection = $('publishSection');
    const ytBtn = $('publishYouTubeBtn');
    const vmBtn = $('publishVimeoBtn');
    if (!publishSection || !ns) return;

    if (ns.ready && ns.blob) {
      publishSection.style.display = 'block';
    } else {
      // Not hiding the section entirely — keep it visible once shown so users
      // see the "Publish for Yardi Aspire" affordance, but disable buttons.
    }

    // Check credentials so we can tooltip-explain why a button is disabled
    const settings = await Settings.getAll();
    const ytReady = !!(settings.youtube.refreshToken || settings.youtube.accessToken);
    const vmReady = !!settings.vimeo.accessToken;
    const hasBlob = !!(ns.ready && ns.blob);

    if (ytBtn) {
      ytBtn.disabled = !hasBlob;
      ytBtn.title = !hasBlob
        ? 'Generate a video first'
        : ytReady
          ? 'Upload to YouTube (unlisted)'
          : 'YouTube not authorized — Settings will open on click';
    }
    if (vmBtn) {
      vmBtn.disabled = !hasBlob;
      vmBtn.title = !hasBlob
        ? 'Generate a video first'
        : vmReady
          ? 'Upload to Vimeo'
          : 'Vimeo not configured — Settings will open on click';
    }
  }

  // ─── Publish action ───────────────────────────────────────────
  async function publishTo(provider) {
    const ns = getNamespace();
    if (!ns || !ns.ready || !ns.blob) {
      return showError('No generated video to publish yet. Click "Generate Video" first.');
    }

    const settings = await Settings.getAll();
    if (provider === 'youtube' && !settings.youtube.refreshToken) {
      return promptOpenSettings('YouTube is not authorized. Open Settings to set it up?');
    }
    if (provider === 'vimeo' && !settings.vimeo.accessToken) {
      return promptOpenSettings('Vimeo is not configured. Open Settings to add your access token?');
    }

    const meta = {
      title: ns.projectName || 'Untitled SOP',
      description: `${ns.stepCount} step SOP captured with FlowCapture for HACSM training.`,
    };

    showProgress(`Uploading to ${provider === 'youtube' ? 'YouTube' : 'Vimeo'}...`, 0);
    disableButtons(true);

    const onProgress = (pct) => showProgress(`Uploading... ${pct}%`, pct);

    try {
      let result;
      if (provider === 'youtube') {
        result = await YT.uploadVideo(ns.blob, {
          title: meta.title,
          description: meta.description,
          tags: ['SOP', 'Training', 'HACSM', 'Yardi Aspire'],
          privacyStatus: settings.defaults.privacy || 'unlisted',
        }, onProgress);
      } else {
        result = await VM.uploadVideo(ns.blob, {
          title: meta.title,
          description: meta.description,
          privacy: settings.defaults.privacy === 'public' ? 'anybody'
                 : settings.defaults.privacy === 'private' ? 'disable'
                 : 'unlisted',
        }, onProgress);
      }

      hideProgress();
      showResult(provider, result);
    } catch (e) {
      hideProgress();
      showError(`Upload failed: ${e.message}`);
    } finally {
      disableButtons(false);
      syncButtonsFromState();
    }
  }

  // ─── UI helpers ───────────────────────────────────────────────
  function disableButtons(disabled) {
    const ytBtn = $('publishYouTubeBtn');
    const vmBtn = $('publishVimeoBtn');
    const ns = getNamespace();
    const hasBlob = !!(ns && ns.ready && ns.blob);
    if (ytBtn) ytBtn.disabled = disabled || !hasBlob;
    if (vmBtn) vmBtn.disabled = disabled || !hasBlob;
  }

  function showProgress(text, pct) {
    const wrap = $('publishProgress');
    const fill = $('publishProgressFill');
    const txt = $('publishProgressText');
    if (wrap) wrap.style.display = 'block';
    if (fill) fill.style.width = `${Math.max(2, pct)}%`;
    if (txt) txt.textContent = text;
  }

  function hideProgress() {
    const wrap = $('publishProgress');
    if (wrap) wrap.style.display = 'none';
  }

  function showResult(provider, result) {
    const box = $('publishResult');
    if (!box) return;
    const providerLabel = provider === 'youtube' ? 'YouTube' : 'Vimeo';
    box.style.display = 'block';
    box.innerHTML = `
      <div class="publish-success">
        <div class="publish-success-header">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="2.5">
            <path d="M22 11.08V12a10 10 0 11-5.93-9.14"/>
            <polyline points="22 4 12 14.01 9 11.01"/>
          </svg>
          <strong>Uploaded to ${providerLabel}!</strong>
        </div>
        <div class="publish-link-row">
          <label>Watch URL</label>
          <div class="copy-row">
            <input type="text" readonly value="${escapeAttr(result.watchUrl)}" id="resWatchUrl">
            <button class="btn btn-outline btn-sm" data-copy-input="resWatchUrl">Copy</button>
          </div>
        </div>
        <div class="publish-link-row">
          <label>Embed URL <span class="for-aspire">(paste this into Yardi Aspire)</span></label>
          <div class="copy-row">
            <input type="text" readonly value="${escapeAttr(result.embedUrl)}" id="resEmbedUrl">
            <button class="btn btn-primary btn-sm" data-copy-input="resEmbedUrl">Copy</button>
          </div>
        </div>
        <div class="publish-link-row">
          <label>Embed iframe HTML</label>
          <div class="copy-row">
            <textarea readonly id="resEmbedIframe" rows="3">${escapeAttr(result.embedIframe)}</textarea>
            <button class="btn btn-outline btn-sm" data-copy-input="resEmbedIframe">Copy</button>
          </div>
        </div>
      </div>
    `;
    box.querySelectorAll('[data-copy-input]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const inp = $(btn.dataset.copyInput);
        if (!inp) return;
        navigator.clipboard.writeText(inp.value).then(() => {
          const orig = btn.textContent;
          btn.textContent = 'Copied!';
          setTimeout(() => (btn.textContent = orig), 1500);
        });
      });
    });
  }

  function showError(msg) {
    const box = $('publishResult');
    if (!box) return;
    box.style.display = 'block';
    box.innerHTML = `<div class="publish-error">⚠ ${escapeHtml(msg)}</div>`;
  }

  function promptOpenSettings(msg) {
    if (confirm(msg)) {
      chrome.tabs.create({ url: chrome.runtime.getURL('src/pages/settings/settings.html') });
    }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }
  function escapeAttr(s) { return escapeHtml(s); }
})();
