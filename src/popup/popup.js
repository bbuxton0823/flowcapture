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

  const captureBtn = document.getElementById('captureBtn');
  const captureBtnText = document.getElementById('captureBtnText');
  const captureIcon = document.getElementById('captureIcon');
  const stepCountEl = document.getElementById('stepCount');
  const editBtn = document.getElementById('editBtn');
  const recordBtn = document.getElementById('recordBtn');
  const videoBtn = document.getElementById('videoBtn');
  const autoVideoBtn = document.getElementById('autoVideoBtn');
  const exportBtn = document.getElementById('exportBtn');
  const clearBtn = document.getElementById('clearBtn');
  const newProjectBtn = document.getElementById('newProjectBtn');
  const projectNameInput = document.getElementById('projectName');

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

    const hasSteps = parseInt(stepCountEl.textContent) > 0;
    editBtn.disabled = !hasSteps;
    videoBtn.disabled = !hasSteps;
    if (autoVideoBtn) autoVideoBtn.disabled = !hasSteps;
    exportBtn.disabled = !hasSteps;
  }

  captureBtn.addEventListener('click', async () => {
    isCapturing = !isCapturing;
    const currentCount = parseInt(stepCountEl.textContent) || 0;
    await chrome.runtime.sendMessage({
      type: MSG.SET_CAPTURING,
      payload: { isCapturing, stepCount: currentCount },
    });
    updateUI();
  });

  editBtn.addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('src/pages/editor/editor.html') });
    window.close();
  });

  recordBtn.addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('src/pages/recorder/recorder.html') });
    window.close();
  });

  videoBtn.addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('src/pages/video/video.html') });
    window.close();
  });

  // ── Auto Video (v1.6): one-click Screenshots → narrated video ──
  if (autoVideoBtn) {
    autoVideoBtn.addEventListener('click', () => {
      const url = chrome.runtime.getURL('src/pages/video/video.html') + '?auto=1';
      chrome.tabs.create({ url });
      window.close();
    });
  }

  exportBtn.addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('src/pages/export/export.html') });
    window.close();
  });

  // ── Export SOP ──
  document.getElementById('exportSopBtn').addEventListener('click', async () => {
    try {
      const { filename, stepCount, sizeMB } = await SOPTransfer.downloadExport();
      alert(`Exported "${filename}" (${stepCount} steps, ${sizeMB} MB).\n\nShare this file with your PCO or manager to review and edit.`);
    } catch (err) {
      alert('Export failed: ' + err.message);
    }
  });

  // ── Import SOP ──
  document.getElementById('importSopBtn').addEventListener('click', async () => {
    const result = await SOPTransfer.promptImport();
    if (!result) return;
    if (result.error) {
      alert('Import failed: ' + result.error);
      return;
    }

    let msg = `Imported "${result.originalName}" (${result.stepCount} steps).\n\nThe SOP is now loaded and fully editable.`;
    if (result.warnings.length > 0) {
      msg += '\n\nWarnings:\n' + result.warnings.join('\n');
    }
    alert(msg);

    // Refresh popup state
    await loadState();
  });

  clearBtn.addEventListener('click', async () => {
    if (confirm('Clear all captured steps? This cannot be undone.')) {
      await chrome.runtime.sendMessage({ type: MSG.CLEAR_STEPS });
      stepCountEl.textContent = '0';
      isCapturing = false;
      updateUI();
    }
  });

  newProjectBtn.addEventListener('click', async () => {
    const name = prompt('New SOP name:', 'Untitled SOP');
    if (name) {
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
      projectNameInput.value = name;
      stepCountEl.textContent = '0';
      isCapturing = false;
      updateUI();
    }
  });

  let nameDebounce;
  projectNameInput.addEventListener('input', () => {
    clearTimeout(nameDebounce);
    nameDebounce = setTimeout(async () => {
      if (currentProject) {
        const result = await chrome.storage.local.get(STORAGE_KEYS.PROJECTS);
        const projects = result[STORAGE_KEYS.PROJECTS] || [];
        const idx = projects.findIndex(p => p.id === currentProject.id);
        if (idx !== -1) {
          projects[idx].name = projectNameInput.value;
          projects[idx].updatedAt = Date.now();
          await chrome.storage.local.set({ [STORAGE_KEYS.PROJECTS]: projects });
        }
      }
    }, 500);
  });

  // ── Team Sync (Optional Google Drive) ──────────────────────────
  const teamSyncToggle = document.getElementById('teamSyncToggle');
  const teamSyncPanel = document.getElementById('teamSyncPanel');
  const syncChevron = document.getElementById('syncChevron');
  const syncBadge = document.getElementById('syncBadge');
  const syncSignedOut = document.getElementById('syncSignedOut');
  const syncSignedIn = document.getElementById('syncSignedIn');
  const syncUserEmail = document.getElementById('syncUserEmail');
  const syncStatus = document.getElementById('syncStatus');

  let syncPanelOpen = false;

  teamSyncToggle.addEventListener('click', () => {
    syncPanelOpen = !syncPanelOpen;
    teamSyncPanel.style.display = syncPanelOpen ? 'block' : 'none';
    teamSyncToggle.classList.toggle('open', syncPanelOpen);
  });

  function showSyncStatus(message, type = 'loading') {
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
        syncSignedOut.style.display = 'none';
        syncSignedIn.style.display = 'block';
        syncUserEmail.textContent = userInfo.email || 'Connected';
        syncBadge.style.display = 'inline';
      } else {
        syncSignedOut.style.display = 'block';
        syncSignedIn.style.display = 'none';
        syncBadge.style.display = 'none';
      }
    } catch {
      syncSignedOut.style.display = 'block';
      syncSignedIn.style.display = 'none';
      syncBadge.style.display = 'none';
    }
  }

  // Sign In
  document.getElementById('driveSignInBtn').addEventListener('click', async () => {
    try {
      showSyncStatus('Connecting to Google Drive...', 'loading');
      await DriveSync.signIn(true);
      await checkDriveConnection();
      showSyncStatus('Connected!', 'success');
    } catch (err) {
      showSyncStatus('Connection failed: ' + err.message, 'error');
    }
  });

  // Sign Out
  document.getElementById('driveSignOutBtn').addEventListener('click', async () => {
    try {
      await DriveSync.signOut();
      syncSignedOut.style.display = 'block';
      syncSignedIn.style.display = 'none';
      syncBadge.style.display = 'none';
      showSyncStatus('Disconnected', 'success');
    } catch (err) {
      showSyncStatus('Error: ' + err.message, 'error');
    }
  });

  // Save to Drive
  document.getElementById('driveSaveBtn').addEventListener('click', async () => {
    try {
      showSyncStatus('Saving to Drive...', 'loading');
      const result = await DriveSync.saveCurrentToDrive();
      showSyncStatus('Saved to Drive!', 'success');
    } catch (err) {
      showSyncStatus('Save failed: ' + err.message, 'error');
    }
  });

  // Open from Drive
  document.getElementById('driveOpenBtn').addEventListener('click', async () => {
    try {
      showSyncStatus('Loading files from Drive...', 'loading');
      const files = await DriveSync.listSOPs();

      if (files.length === 0) {
        showSyncStatus('No SOPs found on Drive', 'error');
        return;
      }

      // Build a simple file picker
      let existingList = document.getElementById('driveFileListContainer');
      if (existingList) existingList.remove();

      const container = document.createElement('div');
      container.id = 'driveFileListContainer';
      container.className = 'drive-file-list';

      files.forEach(f => {
        const item = document.createElement('div');
        item.className = 'drive-file-item';
        const modified = new Date(f.modifiedTime).toLocaleDateString();
        item.innerHTML = `
          <div>
            <div class="drive-file-name">${f.name}</div>
            <div class="drive-file-meta">${f.modifiedBy} · ${modified}</div>
          </div>
        `;
        item.addEventListener('click', async () => {
          try {
            showSyncStatus('Importing from Drive...', 'loading');
            await DriveSync.openFromDrive(f.id);
            showSyncStatus('Imported!', 'success');
            container.remove();
            await loadState();
          } catch (err) {
            showSyncStatus('Import failed: ' + err.message, 'error');
          }
        });
        container.appendChild(item);
      });

      syncSignedIn.appendChild(container);
      syncStatus.style.display = 'none';
    } catch (err) {
      showSyncStatus('Failed to load: ' + err.message, 'error');
    }
  });

  // ── Help / Onboarding ──────────────────────────────────
  document.getElementById('helpBtn').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('src/pages/onboarding/onboarding.html') });
    window.close();
  });

  // ── Settings (API keys & integrations) ─────────────────
  document.getElementById('settingsBtn').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('src/pages/settings/settings.html') });
    window.close();
  });

  // Check Drive connection on load (non-intrusive)
  checkDriveConnection();

  loadState();
})();
