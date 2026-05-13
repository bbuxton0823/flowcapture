/**
 * FlowCapture Background Service Worker
 * =======================================
 * Central message hub: handles screenshot capture, state management,
 * and coordinates between content scripts and extension pages.
 *
 * Self-contained (no ES module imports) for Manifest V3 compatibility.
 */

// Tiny logger shim — service workers cannot `import` the shared logger module
// without ES modules in MV3, so we inline a minimal version here.
const log = {
  info: (...a) => console.log('[FlowCapture:background]', ...a),
  warn: (...a) => console.warn('[FlowCapture:background]', ...a),
  error: (...a) => console.error('[FlowCapture:background]', ...a),
};

// Hard cap on captured steps per project. Beyond this the extension becomes
// sluggish (chrome.storage.local has a 10MB total quota) and PDF/video
// generation OOMs. Surface a clear error instead of silently corrupting.
const MAX_STEPS_PER_PROJECT = 500;

const MSG = {
  CAPTURE_STEP: 'CAPTURE_STEP',
  DELETE_STEP: 'DELETE_STEP',
  GET_STEPS: 'GET_STEPS',
  UPDATE_STEP: 'UPDATE_STEP',
  REORDER_STEPS: 'REORDER_STEPS',
  CLEAR_STEPS: 'CLEAR_STEPS',
  START_RECORDING: 'START_RECORDING',
  STOP_RECORDING: 'STOP_RECORDING',
  GET_RECORDINGS: 'GET_RECORDINGS',
  DELETE_RECORDING: 'DELETE_RECORDING',
  GET_STATE: 'GET_STATE',
  SET_CAPTURING: 'SET_CAPTURING',
  EXPORT_PDF: 'EXPORT_PDF',
  STEP_CAPTURED: 'STEP_CAPTURED',
  CAPTURE_ERROR: 'CAPTURE_ERROR',
};

const STORAGE_KEYS = {
  PROJECTS: 'flowcapture_projects',
  CURRENT_PROJECT: 'flowcapture_current_project',
  SETTINGS: 'flowcapture_settings',
  CAPTURE_STATE: 'flowcapture_capture_state',
};

const DB_CONFIG = {
  NAME: 'FlowCaptureDB',
  VERSION: 1,
  STORES: { SCREENSHOTS: 'screenshots', RECORDINGS: 'recordings' },
};

function generateId() {
  return crypto.randomUUID ? crypto.randomUUID() :
    'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
}

// ─── IndexedDB Helpers ───────────────────────────────────────────────

let dbInstance = null;

function openDB() {
  if (dbInstance) return Promise.resolve(dbInstance);
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_CONFIG.NAME, DB_CONFIG.VERSION);
    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(DB_CONFIG.STORES.SCREENSHOTS))
        db.createObjectStore(DB_CONFIG.STORES.SCREENSHOTS, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(DB_CONFIG.STORES.RECORDINGS))
        db.createObjectStore(DB_CONFIG.STORES.RECORDINGS, { keyPath: 'id' });
    };
    request.onsuccess = (event) => { dbInstance = event.target.result; resolve(dbInstance); };
    request.onerror = (event) => reject(new Error(`IndexedDB error: ${event.target.error}`));
  });
}

async function saveScreenshot(id, dataUrl) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_CONFIG.STORES.SCREENSHOTS, 'readwrite');
    tx.objectStore(DB_CONFIG.STORES.SCREENSHOTS).put({ id, dataUrl, createdAt: Date.now() });
    tx.oncomplete = () => resolve();
    tx.onerror = (e) => reject(e.target.error);
  });
}

async function getScreenshot(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_CONFIG.STORES.SCREENSHOTS, 'readonly');
    const request = tx.objectStore(DB_CONFIG.STORES.SCREENSHOTS).get(id);
    request.onsuccess = () => resolve(request.result);
    request.onerror = (e) => reject(e.target.error);
  });
}

async function deleteScreenshot(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_CONFIG.STORES.SCREENSHOTS, 'readwrite');
    tx.objectStore(DB_CONFIG.STORES.SCREENSHOTS).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = (e) => reject(e.target.error);
  });
}

async function clearAllData() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(
      [DB_CONFIG.STORES.SCREENSHOTS, DB_CONFIG.STORES.RECORDINGS], 'readwrite'
    );
    tx.objectStore(DB_CONFIG.STORES.SCREENSHOTS).clear();
    tx.objectStore(DB_CONFIG.STORES.RECORDINGS).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = (e) => reject(e.target.error);
  });
}

// ─── Chrome Storage Helpers ──────────────────────────────────────────

async function getProjects() {
  const result = await chrome.storage.local.get(STORAGE_KEYS.PROJECTS);
  return result[STORAGE_KEYS.PROJECTS] || [];
}

async function getCurrentProject() {
  const result = await chrome.storage.local.get([
    STORAGE_KEYS.PROJECTS, STORAGE_KEYS.CURRENT_PROJECT,
  ]);
  const projects = result[STORAGE_KEYS.PROJECTS] || [];
  const currentId = result[STORAGE_KEYS.CURRENT_PROJECT];

  if (currentId) {
    const found = projects.find(p => p.id === currentId);
    if (found) return found;
  }

  if (projects.length === 0) {
    const newProject = {
      id: generateId(), name: 'My First SOP', description: '',
      createdAt: Date.now(), updatedAt: Date.now(), steps: [],
      settings: { includeUrls: true, exportFormat: 'pdf', exportFormats: ['pdf', 'html'] },
    };
    await chrome.storage.local.set({
      [STORAGE_KEYS.PROJECTS]: [newProject],
      [STORAGE_KEYS.CURRENT_PROJECT]: newProject.id,
    });
    return newProject;
  }

  return projects[0];
}

async function updateProject(updatedProject) {
  const projects = await getProjects();
  const index = projects.findIndex(p => p.id === updatedProject.id);
  if (index !== -1) {
    projects[index] = { ...updatedProject, updatedAt: Date.now() };
    await chrome.storage.local.set({ [STORAGE_KEYS.PROJECTS]: projects });
  }
}

async function getCaptureState() {
  const result = await chrome.storage.local.get(STORAGE_KEYS.CAPTURE_STATE);
  return result[STORAGE_KEYS.CAPTURE_STATE] || { isCapturing: false, stepCount: 0 };
}

async function setCaptureState(state) {
  await chrome.storage.local.set({ [STORAGE_KEYS.CAPTURE_STATE]: state });
}

// ─── Badge ───────────────────────────────────────────────────────────

async function updateBadge(isCapturing, stepCount) {
  if (isCapturing) {
    await chrome.action.setBadgeBackgroundColor({ color: '#EF4444' });
    await chrome.action.setBadgeText({ text: stepCount > 0 ? String(stepCount) : 'REC' });
  } else {
    await chrome.action.setBadgeText({ text: '' });
  }
}

// ─── Extension Install ──────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === 'install') {
    const project = {
      id: generateId(), name: 'My First SOP', description: '',
      createdAt: Date.now(), updatedAt: Date.now(), steps: [],
      settings: { includeUrls: true, exportFormat: 'pdf', exportFormats: ['pdf', 'html'] },
    };
    await chrome.storage.local.set({
      [STORAGE_KEYS.PROJECTS]: [project],
      [STORAGE_KEYS.CURRENT_PROJECT]: project.id,
      [STORAGE_KEYS.CAPTURE_STATE]: { isCapturing: false, stepCount: 0 },
      flowcapture_onboarding_complete: false,
    });
    // Open onboarding wizard on first install
    chrome.tabs.create({
      url: chrome.runtime.getURL('src/pages/onboarding/onboarding.html'),
    });
    log.info('Installed — default project created, onboarding opened.');
  }

  // On update: show onboarding if user hasn't completed it yet
  if (details.reason === 'update') {
    const result = await chrome.storage.local.get('flowcapture_onboarding_complete');
    if (!result.flowcapture_onboarding_complete) {
      chrome.tabs.create({
        url: chrome.runtime.getURL('src/pages/onboarding/onboarding.html'),
      });
      log.info('Updated — onboarding not yet completed, reopening.');
    }
  }
});

// ─── Message Handler ─────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      switch (message.type) {

        case MSG.SET_CAPTURING: {
          const newState = {
            isCapturing: message.payload.isCapturing,
            stepCount: message.payload.stepCount || 0,
          };
          await setCaptureState(newState);
          await updateBadge(newState.isCapturing, newState.stepCount);

          // Notify the active tab FIRST and synchronously — this is the tab
          // the user wants to capture on. If the content script is missing
          // (popped extension, fresh install on an already-open tab), inject
          // it so the state lands before we respond to the popup.
          let activeTabId = null;
          try {
            const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
            if (activeTab?.id) {
              activeTabId = activeTab.id;
              await chrome.tabs.sendMessage(activeTab.id, {
                type: MSG.SET_CAPTURING,
                payload: newState,
              }).catch(() => {
                return chrome.scripting.executeScript({
                  target: { tabId: activeTab.id },
                  files: ['src/content/content.js'],
                }).catch(() => {});
              });
            }
          } catch (_) {}

          sendResponse({ success: true, state: newState });

          // Broadcast to all other tabs in background (fire-and-forget)
          chrome.tabs.query({}).then(tabs => {
            tabs.forEach(tab => {
              if (tab.id === activeTabId) return;
              chrome.tabs.sendMessage(tab.id, { type: MSG.SET_CAPTURING, payload: newState })
                .catch(() => {});
            });
          });
          break;
        }

        case MSG.GET_STATE: {
          const state = await getCaptureState();
          const project = await getCurrentProject();
          sendResponse({ success: true, state, project, stepCount: project.steps.length });
          break;
        }

        case MSG.CAPTURE_STEP: {
          const state = await getCaptureState();
          if (!state.isCapturing) {
            sendResponse({ success: false, error: 'Not in capture mode' });
            break;
          }

          const project = await getCurrentProject();
          if (project.steps.length >= MAX_STEPS_PER_PROJECT) {
            sendResponse({
              success: false,
              error: `Step limit reached (${MAX_STEPS_PER_PROJECT}). Export or split this SOP before capturing more.`,
            });
            break;
          }

          // Validate sender — only capture if request came from a real tab
          // we can capture (skip chrome:// pages, the new-tab page, etc.).
          const tabId = sender?.tab?.id;
          if (tabId == null) {
            sendResponse({ success: false, error: 'Capture request missing tab context' });
            break;
          }

          let screenshotDataUrl;
          try {
            const windowId = sender?.tab?.windowId ?? null;
            screenshotDataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'png', quality: 92 });
          } catch (err) {
            log.warn('captureVisibleTab failed:', err.message);
            sendResponse({ success: false, error: 'Screenshot failed: ' + err.message });
            break;
          }

          const stepId = generateId();
          await saveScreenshot(stepId, screenshotDataUrl);

          const step = {
            id: stepId,
            sequenceNumber: project.steps.length + 1,
            title: message.payload.description || `Step ${project.steps.length + 1}`,
            description: '',
            url: message.payload.url || '',
            timestamp: Date.now(),
            elementSelector: message.payload.elementSelector || '',
            elementText: message.payload.elementText || '',
            screenshotDataUrl: stepId,
            annotations: [],
          };

          project.steps.push(step);
          await updateProject(project);

          const newCount = project.steps.length;
          await setCaptureState({ isCapturing: true, stepCount: newCount });
          await updateBadge(true, newCount);

          sendResponse({ success: true, stepId: step.id, stepNumber: newCount });
          break;
        }

        case MSG.GET_STEPS: {
          const proj = await getCurrentProject();
          const stepsWithImages = await Promise.all(
            proj.steps.map(async (step) => {
              try {
                const screenshot = await getScreenshot(step.screenshotDataUrl || step.id);
                return { ...step, imageData: screenshot?.dataUrl || null };
              } catch {
                return { ...step, imageData: null };
              }
            })
          );
          sendResponse({ success: true, steps: stepsWithImages, project: proj });
          break;
        }

        case MSG.UPDATE_STEP: {
          const proj = await getCurrentProject();
          const idx = proj.steps.findIndex(s => s.id === message.payload.id);
          if (idx !== -1) {
            proj.steps[idx] = { ...proj.steps[idx], ...message.payload.updates };
            await updateProject(proj);
            sendResponse({ success: true });
          } else {
            sendResponse({ success: false, error: 'Step not found' });
          }
          break;
        }

        case MSG.DELETE_STEP: {
          const proj = await getCurrentProject();
          const stepIdx = proj.steps.findIndex(s => s.id === message.payload.id);
          if (stepIdx !== -1) {
            const removed = proj.steps.splice(stepIdx, 1)[0];
            proj.steps.forEach((s, i) => { s.sequenceNumber = i + 1; });
            await updateProject(proj);
            try { await deleteScreenshot(removed.screenshotDataUrl || removed.id); } catch (_) {}
            sendResponse({ success: true });
          } else {
            sendResponse({ success: false, error: 'Step not found' });
          }
          break;
        }

        case MSG.REORDER_STEPS: {
          const proj = await getCurrentProject();
          const { fromIndex, toIndex } = message.payload;
          const [movedStep] = proj.steps.splice(fromIndex, 1);
          proj.steps.splice(toIndex, 0, movedStep);
          proj.steps.forEach((s, i) => { s.sequenceNumber = i + 1; });
          await updateProject(proj);
          sendResponse({ success: true });
          break;
        }

        case MSG.CLEAR_STEPS: {
          const proj = await getCurrentProject();
          proj.steps = [];
          await updateProject(proj);
          await clearAllData();
          await setCaptureState({ isCapturing: false, stepCount: 0 });
          await updateBadge(false, 0);
          sendResponse({ success: true });
          break;
        }

        default:
          sendResponse({ success: false, error: `Unknown: ${message.type}` });
      }
    } catch (error) {
      log.error('Message handler error:', error);
      sendResponse({ success: false, error: error?.message || 'Internal error' });
    }
  })();
  return true;
});

// ─── Tab Updated (notify content scripts) ────────────────────────────

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (changeInfo.status !== 'complete') return;
  try {
    const state = await getCaptureState();
    if (state.isCapturing) {
      try {
        await chrome.tabs.sendMessage(tabId, { type: MSG.SET_CAPTURING, payload: state });
      } catch (_) {
        // Tabs without the content script (chrome://, extension pages) reject
        // sendMessage. Expected; don't spam the log.
      }
    }
  } catch (err) {
    log.warn('tabs.onUpdated handler failed:', err);
  }
});

// ─── Graceful shutdown ───────────────────────────────────────────────
// MV3 suspends the service worker after ~30s of idle. Close the DB so the
// next wake-up reopens cleanly instead of inheriting a possibly-stale handle.
chrome.runtime.onSuspend.addListener(() => {
  try {
    if (dbInstance) {
      dbInstance.close();
      dbInstance = null;
      log.info('IndexedDB connection closed for suspend.');
    }
  } catch (err) {
    log.warn('Suspend cleanup failed:', err);
  }
});

log.info('Service worker loaded.');
