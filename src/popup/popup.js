/**
 * FlowCapture Popup Controller
 * ==============================
 * Manages the popup UI: start/stop capture, navigate to editor/recorder/export.
 */

(function() {
  'use strict';

  const MSG = {
    GET_STATE: 'GET_STATE',
    SET_CAPTURING: 'SET_CAPTURING',
    CLEAR_STEPS: 'CLEAR_STEPS',
  };

  const STORAGE_KEYS = {
    PROJECTS: 'flowcapture_projects',
    CURRENT_PROJECT: 'flowcapture_current_project',
  };

  function $(id) { return document.getElementById(id); }
  function on(el, evt, fn) { if (el) el.addEventListener(evt, fn); }
  function escapeHtml(s) {
    const div = document.createElement('div');
    div.textContent = s == null ? '' : String(s);
    return div.innerHTML;
  }

  const captureBtn = $('captureBtn');
  const captureBtnText = $('captureBtnText');
  const captureIcon = $('captureIcon');
  const stepCountEl = $('stepCount');
  const editBtn = $('editBtn');
  const recordBtn = $('recordBtn');
  const videoBtn = $('videoBtn');
  const autoVideoBtn = $('autoVideoBtn');
  const exportBtn = $('exportBtn');
  const clearBtn = $('clearBtn');
  const newProjectBtn = $('newProjectBtn');
  const projectNameInput = $('projectName');

  let isCapturing = false;
  let currentProject = null;

  function generateId() {
    return crypto.randomUUID ? crypto.randomUUID() :
      'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
      });
  }

  async function loadState() {
    try {
      const response = await chrome.runtime.sendMessage({ type: MSG.GET_STATE });
      if (response?.success) {
        isCapturing = response.state.isCapturing;
        currentProject = response.project;
        stepCountEl.textContent = response.stepCount || 0;
        projectNameInput.value = currentProject?.name || 'Untitled SOP';
        updateUI();
      }
    } catch (err) {
      console.error('[FlowCapture] Failed to load state:', err);
    }
  }

  function updateUI() {
    if (isCapturing) {
      captureBtn.classList.add('active');
      captureBtnText.textContent = 'Stop Capturing';
      captureIcon.innerHTML = '<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/>';
    } else {
      captureBtn.classList.remove('active');
      captureBtnText.textContent = 'Start Capturing';
      captureIcon.innerHTML = '<circle cx="12" cy="12" r="10"/>';
    }

    const hasSteps = parseInt(stepCountEl.textContent, 10) > 0;
    editBtn.disabled = !hasSteps;
    videoBtn.disabled = !hasSteps;
    if (autoVideoBtn) autoVideoBtn.disabled = !hasSteps;
    exportBtn.disabled = !hasSteps;
  }

  on(captureBtn, 'click', async () => {
    captureBtn.disabled = true;
    const desired = !isCapturing;
    const currentCount = parseInt(stepCountEl?.textContent, 10) || 0;
    try {
      // MV3 service workers can be suspended — retry once on connection error
      let response;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          response = await chrome.runtime.sendMessage({
            type: MSG.SET_CAPTURING,
            payload: { isCapturing: desired, stepCount: currentCount },
          });
          break;
        } catch (err) {
          if (attempt === 0 && err?.message?.includes('Receiving end does not exist')) {
            // SW was suspended — give it 200ms to wake then retry
            await new Promise(r => setTimeout(r, 200));
            continue;
          }
          throw err;
        }
      }
      if (response?.success) {
        isCapturing = desired;
        updateUI();
      } else {
        console.error('[FlowCapture] SET_CAPTURING failed:', response?.error);
        alert('Could not toggle capture. Try reloading the extension.');
      }
    } catch (err) {
      console.error('[FlowCapture] Capture toggle error:', err);
      alert('Capture error: ' + (err?.message || 'Unknown'));
    } finally {
      captureBtn.disabled = false;
    }
  });

  on(editBtn, 'click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('src/pages/editor/editor.html') });
    window.close();
  });

  on(recordBtn, 'click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('src/pages/recorder/recorder.html') });
    window.close();
  });

  on(videoBtn, 'click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('src/pages/video/video.html') });
    window.close();
  });

  // Auto Video (v1.6): one-click Screenshots → narrated video
  on(autoVideoBtn, 'click', () => {
    const url = chrome.runtime.getURL('src/pages/video/video.html') + '?auto=1';
    chrome.tabs.create({ url });
    window.close();
  });

  on(exportBtn, 'click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('src/pages/export/export.html') });
    window.close();
  });

  // ── Export SOP ──
  on($('exportSopBtn'), 'click', async () => {
    try {
      const { filename, stepCount, sizeMB } = await SOPTransfer.downloadExport();
      alert(`Exported "${filename}" (${stepCount} steps, ${sizeMB} MB).\n\nShare this file with your PCO or manager to review and edit.`);
    } catch (err) {
      alert('Export failed: ' + (err?.message || 'Unknown error'));
    }
  });

  // ── Import SOP ──
  on($('importSopBtn'), 'click', async () => {
    const result = await SOPTransfer.promptImport();
    if (!result) return;
    if (result.error) {
      alert('Import failed: ' + result.error);
      return;
    }

    let msg = `Imported "${result.originalName}" (${result.stepCount} steps).\n\nThe SOP is now loaded and fully editable.`;
    if (result.warnings?.length > 0) {
      msg += '\n\nWarnings:\n' + result.warnings.join('\n');
    }
    alert(msg);

    // Refresh popup state
    await loadState();
  });

  on(clearBtn, 'click', async () => {
    if (confirm('Clear all captured steps? This cannot be undone.')) {
      await chrome.runtime.sendMessage({ type: MSG.CLEAR_STEPS });
      if (stepCountEl) stepCountEl.textContent = '0';
      isCapturing = false;
      updateUI();
    }
  });

  on(newProjectBtn, 'click', async () => {
    const rawName = prompt('New SOP name:', 'Untitled SOP');
    if (!rawName) return;
    const name = rawName.trim().slice(0, 200);
    if (!name) return;

    const newProject = {
      id: generateId(), name, description: '',
      createdAt: Date.now(), updatedAt: Date.now(), steps: [],
      settings: { includeUrls: true, exportFormat: 'pdf' },
    };
    const result = await chrome.storage.local.get(STORAGE_KEYS.PROJECTS);
    const projects = result[STORAGE_KEYS.PROJECTS] || [];
    projects.push(newProject);
    await chrome.storage.local.set({
      [STORAGE_KEYS.PROJECTS]: projects,
      [STORAGE_KEYS.CURRENT_PROJECT]: newProject.id,
    });
    if (projectNameInput) projectNameInput.value = name;
    if (stepCountEl) stepCountEl.textContent = '0';
    isCapturing = false;
    updateUI();
  });

  let nameDebounce;
  on(projectNameInput, 'input', () => {
    clearTimeout(nameDebounce);
    nameDebounce = setTimeout(async () => {
      if (!currentProject) return;
      const result = await chrome.storage.local.get(STORAGE_KEYS.PROJECTS);
      const projects = result[STORAGE_KEYS.PROJECTS] || [];
      const idx = projects.findIndex(p => p.id === currentProject.id);
      if (idx !== -1) {
        projects[idx].name = projectNameInput.value.trim().slice(0, 200) || 'Untitled SOP';
        projects[idx].updatedAt = Date.now();
        await chrome.storage.local.set({ [STORAGE_KEYS.PROJECTS]: projects });
      }
    }, 500);
  });

  // ── Team Sync (Optional Google Drive) ──────────────────────────
  const teamSyncToggle = $('teamSyncToggle');
  const teamSyncPanel = $('teamSyncPanel');
  const syncBadge = $('syncBadge');
  const syncSignedOut = $('syncSignedOut');
  const syncSignedIn = $('syncSignedIn');
  const syncUserEmail = $('syncUserEmail');
  const syncStatus = $('syncStatus');

  let syncPanelOpen = false;

  on(teamSyncToggle, 'click', () => {
    if (!teamSyncPanel || !teamSyncToggle) return;
    syncPanelOpen = !syncPanelOpen;
    teamSyncPanel.style.display = syncPanelOpen ? 'block' : 'none';
    teamSyncToggle.classList.toggle('open', syncPanelOpen);
  });

  function showSyncStatus(message, type = 'loading') {
    if (!syncStatus) return;
    syncStatus.textContent = message;
    syncStatus.className = 'sync-status ' + type;
    syncStatus.style.display = 'block';
    if (type !== 'loading') {
      setTimeout(() => { syncStatus.style.display = 'none'; }, 4000);
    }
  }

  async function checkDriveConnection() {
    try {
      if (typeof DriveSync === 'undefined') return;
      const signedIn = await DriveSync.isSignedIn();
      if (signedIn) {
        const userInfo = await DriveSync.getUserInfo();
        if (syncSignedOut) syncSignedOut.style.display = 'none';
        if (syncSignedIn) syncSignedIn.style.display = 'block';
        if (syncUserEmail) syncUserEmail.textContent = userInfo.email || 'Connected';
        if (syncBadge) syncBadge.style.display = 'inline';
      } else {
        if (syncSignedOut) syncSignedOut.style.display = 'block';
        if (syncSignedIn) syncSignedIn.style.display = 'none';
        if (syncBadge) syncBadge.style.display = 'none';
      }
    } catch {
      if (syncSignedOut) syncSignedOut.style.display = 'block';
      if (syncSignedIn) syncSignedIn.style.display = 'none';
      if (syncBadge) syncBadge.style.display = 'none';
    }
  }

  // Sign In
  on($('driveSignInBtn'), 'click', async () => {
    try {
      showSyncStatus('Connecting to Google Drive...', 'loading');
      await DriveSync.signIn(true);
      await checkDriveConnection();
      showSyncStatus('Connected!', 'success');
    } catch (err) {
      showSyncStatus('Connection failed: ' + (err?.message || 'Unknown error'), 'error');
    }
  });

  // Sign Out
  on($('driveSignOutBtn'), 'click', async () => {
    try {
      await DriveSync.signOut();
      if (syncSignedOut) syncSignedOut.style.display = 'block';
      if (syncSignedIn) syncSignedIn.style.display = 'none';
      if (syncBadge) syncBadge.style.display = 'none';
      showSyncStatus('Disconnected', 'success');
    } catch (err) {
      showSyncStatus('Error: ' + (err?.message || 'Unknown error'), 'error');
    }
  });

  // Save to Drive
  on($('driveSaveBtn'), 'click', async () => {
    try {
      showSyncStatus('Saving to Drive...', 'loading');
      await DriveSync.saveCurrentToDrive();
      showSyncStatus('Saved to Drive!', 'success');
    } catch (err) {
      showSyncStatus('Save failed: ' + (err?.message || 'Unknown error'), 'error');
    }
  });

  // Open from Drive
  on($('driveOpenBtn'), 'click', async () => {
    try {
      showSyncStatus('Loading files from Drive...', 'loading');
      const files = await DriveSync.listSOPs();

      if (files.length === 0) {
        showSyncStatus('No SOPs found on Drive', 'error');
        return;
      }

      const existingList = $('driveFileListContainer');
      if (existingList) existingList.remove();

      const container = document.createElement('div');
      container.id = 'driveFileListContainer';
      container.className = 'drive-file-list';

      // Build list with safe DOM construction (Drive file names + modifiedBy
      // are not trusted — they come from arbitrary Google accounts that share
      // the team folder. innerHTML interpolation here would be XSS.)
      files.forEach(f => {
        const item = document.createElement('div');
        item.className = 'drive-file-item';
        const left = document.createElement('div');
        const nameDiv = document.createElement('div');
        nameDiv.className = 'drive-file-name';
        nameDiv.textContent = f.name || '(unnamed)';
        const metaDiv = document.createElement('div');
        metaDiv.className = 'drive-file-meta';
        const modified = f.modifiedTime ? new Date(f.modifiedTime).toLocaleDateString() : '';
        metaDiv.textContent = `${f.modifiedBy || 'Unknown'} · ${modified}`;
        left.appendChild(nameDiv);
        left.appendChild(metaDiv);
        item.appendChild(left);
        item.addEventListener('click', async () => {
          try {
            showSyncStatus('Importing from Drive...', 'loading');
            await DriveSync.openFromDrive(f.id);
            showSyncStatus('Imported!', 'success');
            container.remove();
            await loadState();
          } catch (err) {
            showSyncStatus('Import failed: ' + (err?.message || 'Unknown error'), 'error');
          }
        });
        container.appendChild(item);
      });

      if (syncSignedIn) syncSignedIn.appendChild(container);
      if (syncStatus) syncStatus.style.display = 'none';
    } catch (err) {
      showSyncStatus('Failed to load: ' + (err?.message || 'Unknown error'), 'error');
    }
  });

  // ── Help / Onboarding ──────────────────────────────────
  on($('helpBtn'), 'click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('src/pages/onboarding/onboarding.html') });
    window.close();
  });

  // ── Settings (API keys & integrations) ─────────────────
  on($('settingsBtn'), 'click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('src/pages/settings/settings.html') });
    window.close();
  });

  // Check Drive connection on load (non-intrusive)
  checkDriveConnection();

  loadState();
})();
