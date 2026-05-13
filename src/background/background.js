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
  CREATE_PROJECT: 'CREATE_PROJECT',
  UPDATE_PROJECT: 'UPDATE_PROJECT',
  IMPORT_PROJECT: 'IMPORT_PROJECT',
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

// chrome.storage.local writes are read/modify/write operations. Serializing all
// project mutations prevents rapid captures or parallel pages from overwriting
// each other's changes.
let projectWriteQueue = Promise.resolve();
function enqueueProjectWrite(task) {
  const run = projectWriteQueue.catch(() => {}).then(task);
  projectWriteQueue = run.catch(() => {});
  return run;
}

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
    request.onsuccess = (event) => {
      dbInstance = event.target.result;
      // After the SW sleeps and wakes the existing connection can be closed
      // by the platform. Drop our cached reference so the next openDB() call
      // re-opens cleanly instead of reusing a dead handle.
      dbInstance.onclose = () => { dbInstance = null; };
      resolve(dbInstance);
    };
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

function broadcastCaptureState(state) {
  chrome.tabs.query({}).then(tabs => {
    tabs.forEach(tab => {
      chrome.tabs.sendMessage(tab.id, { type: MSG.SET_CAPTURING, payload: state })
        .catch(() => {});
    });
  }).catch(() => {});
}

async function syncCaptureCount(stepCount, { stop = false, notifyTabs = false } = {}) {
  const latestState = await getCaptureState();
  const isCapturing = stop ? false : !!latestState.isCapturing;
  const nextState = { isCapturing, stepCount };
  await setCaptureState(nextState);
  await updateBadge(isCapturing, stepCount);
  if (notifyTabs) broadcastCaptureState(nextState);
  return nextState;
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
          const result = await enqueueProjectWrite(async () => {
            const state = await getCaptureState();
            if (!state.isCapturing) {
              return { success: false, error: 'Not in capture mode' };
            }

            const project = await getCurrentProject();
            if (project.steps.length >= MAX_STEPS_PER_PROJECT) {
              return {
                success: false,
                error: `Step limit reached (${MAX_STEPS_PER_PROJECT}). Export or split this SOP before capturing more.`,
              };
            }

            // Validate sender — only capture if request came from a real tab
            // we can capture (skip chrome:// pages, the new-tab page, etc.).
            const tabId = sender?.tab?.id;
            if (tabId == null) {
              return { success: false, error: 'Capture request missing tab context' };
            }

            const windowId = sender?.tab?.windowId;
            if (windowId == null) {
              return { success: false, error: 'No windowId — cannot capture this tab' };
            }

            let screenshotDataUrl;
            try {
              screenshotDataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'png', quality: 92 });
            } catch (err) {
              log.warn('captureVisibleTab failed:', err.message);
              return { success: false, error: 'Screenshot failed: ' + err.message };
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
            // Re-read capture state before re-asserting isCapturing=true. The
            // user may have toggled capture off during the await chain above;
            // don't clobber that decision.
            await syncCaptureCount(newCount);

            return { success: true, stepId: step.id, stepNumber: newCount };
          });
          sendResponse(result);
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
          const result = await enqueueProjectWrite(async () => {
            const proj = await getCurrentProject();
            const idx = proj.steps.findIndex(s => s.id === message.payload.id);
            if (idx !== -1) {
              proj.steps[idx] = { ...proj.steps[idx], ...message.payload.updates };
              await updateProject(proj);
              return { success: true };
            }
            return { success: false, error: 'Step not found' };
          });
          sendResponse(result);
          break;
        }

        case MSG.DELETE_STEP: {
          const result = await enqueueProjectWrite(async () => {
            const proj = await getCurrentProject();
            const stepIdx = proj.steps.findIndex(s => s.id === message.payload.id);
            if (stepIdx !== -1) {
              const removed = proj.steps.splice(stepIdx, 1)[0];
              proj.steps.forEach((s, i) => { s.sequenceNumber = i + 1; });
              await updateProject(proj);
              try { await deleteScreenshot(removed.screenshotDataUrl || removed.id); } catch (_) {}
              await syncCaptureCount(proj.steps.length);
              return { success: true };
            }
            return { success: false, error: 'Step not found' };
          });
          sendResponse(result);
          break;
        }

        case MSG.REORDER_STEPS: {
          const result = await enqueueProjectWrite(async () => {
            const proj = await getCurrentProject();
            const { fromIndex, toIndex } = message.payload;
            if (
              !Number.isInteger(fromIndex) ||
              !Number.isInteger(toIndex) ||
              fromIndex < 0 ||
              toIndex < 0 ||
              fromIndex >= proj.steps.length ||
              toIndex >= proj.steps.length
            ) {
              return { success: false, error: 'Invalid reorder indices' };
            }
            const [movedStep] = proj.steps.splice(fromIndex, 1);
            proj.steps.splice(toIndex, 0, movedStep);
            proj.steps.forEach((s, i) => { s.sequenceNumber = i + 1; });
            await updateProject(proj);
            return { success: true };
          });
          sendResponse(result);
          break;
        }

        case MSG.CLEAR_STEPS: {
          const result = await enqueueProjectWrite(async () => {
            const proj = await getCurrentProject();
            const screenshotIds = proj.steps
              .map(s => s.screenshotDataUrl || s.id)
              .filter(Boolean);
            proj.steps = [];
            await updateProject(proj);
            await Promise.allSettled(screenshotIds.map(id => deleteScreenshot(id)));
            await syncCaptureCount(0, { stop: true, notifyTabs: true });
            return { success: true };
          });
          sendResponse(result);
          break;
        }

        // ── Single-writer project mutations ──
        // Callers (editor, popup, sop-transfer) must use these instead of
        // writing chrome.storage.local.flowcapture_projects directly, to avoid
        // lost-write races when multiple tabs mutate the project list at once.

        case MSG.CREATE_PROJECT: {
          const result = await enqueueProjectWrite(async () => {
            const projects = await getProjects();
            const incoming = message.payload?.project || {};
            const newProject = {
              id: incoming.id || generateId(),
              name: (incoming.name || 'Untitled SOP').toString().slice(0, 200),
              description: incoming.description || '',
              createdAt: incoming.createdAt || Date.now(),
              updatedAt: Date.now(),
              steps: Array.isArray(incoming.steps) ? incoming.steps : [],
              settings: incoming.settings || { includeUrls: true, exportFormat: 'pdf' },
            };
            projects.push(newProject);
            await chrome.storage.local.set({
              [STORAGE_KEYS.PROJECTS]: projects,
              [STORAGE_KEYS.CURRENT_PROJECT]: newProject.id,
            });
            await syncCaptureCount(0, { stop: true, notifyTabs: true });
            return { success: true, project: newProject, id: newProject.id };
          });
          sendResponse(result);
          break;
        }

        case MSG.UPDATE_PROJECT: {
          const result = await enqueueProjectWrite(async () => {
            const { id, patch } = message.payload || {};
            if (!id || !patch || typeof patch !== 'object') {
              return { success: false, error: 'UPDATE_PROJECT requires {id, patch}' };
            }
            const projects = await getProjects();
            const idx = projects.findIndex(p => p.id === id);
            if (idx === -1) {
              return { success: false, error: 'Project not found' };
            }
            projects[idx] = { ...projects[idx], ...patch, id, updatedAt: Date.now() };
            await chrome.storage.local.set({ [STORAGE_KEYS.PROJECTS]: projects });
            if (Array.isArray(patch.steps)) {
              const current = await getCurrentProject();
              if (current.id === id) await syncCaptureCount(patch.steps.length);
            }
            return { success: true, project: projects[idx] };
          });
          sendResponse(result);
          break;
        }

        case MSG.IMPORT_PROJECT: {
          const result = await enqueueProjectWrite(async () => {
            const incoming = message.payload?.project;
            if (!incoming || !incoming.id) {
              return { success: false, error: 'IMPORT_PROJECT requires {project}' };
            }
            const projects = await getProjects();
            projects.push({ ...incoming, updatedAt: Date.now() });
            await chrome.storage.local.set({
              [STORAGE_KEYS.PROJECTS]: projects,
              [STORAGE_KEYS.CURRENT_PROJECT]: incoming.id,
            });
            await syncCaptureCount(Array.isArray(incoming.steps) ? incoming.steps.length : 0, { stop: true, notifyTabs: true });
            return { success: true, id: incoming.id };
          });
          sendResponse(result);
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
