/**
 * FlowCapture Content Script
 * ===========================
 * Injected into every page. Detects user clicks, extracts element info,
 * sends capture requests to the background service worker.
 *
 * NOTE: Content scripts cannot use ES module imports in Manifest V3.
 * Message types are duplicated here intentionally.
 */

(function() {
  'use strict';

  const MSG = {
    CAPTURE_STEP: 'CAPTURE_STEP',
    SET_CAPTURING: 'SET_CAPTURING',
    GET_STATE: 'GET_STATE',
  };

  let isCapturing = false;
  let clickDebounceTimer = null;
  let notificationEl = null;
  let captureBanner = null;

  // ─── Element Info Extraction ─────────────────────────────────────

  function getElementSelector(el) {
    if (!el || el === document.body || el === document.documentElement) return 'body';
    const parts = [];
    let current = el;
    while (current && current !== document.body) {
      let selector = current.tagName.toLowerCase();
      if (current.id) {
        selector += `#${current.id}`;
        parts.unshift(selector);
        break;
      }
      if (current.className && typeof current.className === 'string') {
        const classes = current.className.trim().split(/\s+/).slice(0, 2).join('.');
        if (classes) selector += `.${classes}`;
      }
      const parent = current.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter(c => c.tagName === current.tagName);
        if (siblings.length > 1) {
          const index = siblings.indexOf(current) + 1;
          selector += `:nth-child(${index})`;
        }
      }
      parts.unshift(selector);
      current = current.parentElement;
    }
    return parts.join(' > ');
  }

  function getElementText(el) {
    if (!el) return '';
    const text = el.innerText || el.textContent || el.value ||
      el.getAttribute('aria-label') || el.getAttribute('title') ||
      el.getAttribute('placeholder') || el.getAttribute('alt') || '';
    return text.trim().substring(0, 150);
  }

  function getElementDescription(el) {
    if (!el) return '';
    const tag = el.tagName?.toLowerCase() || '';
    const type = el.getAttribute('type') || '';
    const role = el.getAttribute('role') || '';
    const text = getElementText(el);

    let desc = '';
    if (tag === 'button' || role === 'button') desc = 'Clicked button';
    else if (tag === 'a') desc = 'Clicked link';
    else if (tag === 'input') desc = `Clicked ${type || 'input'} field`;
    else if (tag === 'select') desc = 'Clicked dropdown';
    else if (tag === 'textarea') desc = 'Clicked text area';
    else desc = `Clicked ${tag}`;

    if (text) desc += `: "${text.substring(0, 80)}"`;
    return desc;
  }

  // ─── Visual Feedback ─────────────────────────────────────────────

  function showClickHighlight(x, y) {
    const ring = document.createElement('div');
    ring.className = 'flowcapture-click-ring';
    ring.style.cssText = `
      position: fixed;
      left: ${x - 20}px;
      top: ${y - 20}px;
      width: 40px;
      height: 40px;
      border-radius: 50%;
      border: 3px solid #6366f1;
      pointer-events: none;
      z-index: 2147483647;
      animation: flowcapture-ripple 0.6s ease-out forwards;
    `;
    document.body.appendChild(ring);
    setTimeout(() => ring.remove(), 700);
  }

  function showNotification(stepNumber) {
    if (notificationEl) notificationEl.remove();
    notificationEl = document.createElement('div');
    notificationEl.className = 'flowcapture-notification';
    notificationEl.innerHTML = `
      <div style="
        position: fixed;
        top: 16px;
        right: 16px;
        background: #6366f1;
        color: white;
        padding: 10px 18px;
        border-radius: 10px;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        font-size: 14px;
        font-weight: 500;
        z-index: 2147483647;
        box-shadow: 0 4px 20px rgba(99, 102, 241, 0.4);
        display: flex;
        align-items: center;
        gap: 8px;
        animation: flowcapture-slideIn 0.3s ease-out, flowcapture-fadeOut 0.3s ease-in 1.5s forwards;
      ">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <polyline points="20 6 9 17 4 12"></polyline>
        </svg>
        Step ${stepNumber} captured
      </div>
    `;
    document.body.appendChild(notificationEl);
    setTimeout(() => { if (notificationEl) notificationEl.remove(); }, 2000);
  }

  function showErrorNotification(message) {
    if (notificationEl) notificationEl.remove();
    notificationEl = document.createElement('div');
    notificationEl.className = 'flowcapture-notification';
    const inner = document.createElement('div');
    inner.style.cssText = `
      position: fixed;
      top: 16px;
      right: 16px;
      background: #ef4444;
      color: white;
      padding: 10px 18px;
      border-radius: 10px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 14px;
      font-weight: 500;
      z-index: 2147483647;
      box-shadow: 0 4px 20px rgba(239,68,68,0.4);
      display: flex;
      align-items: center;
      gap: 8px;
      animation: flowcapture-slideIn 0.3s ease-out, flowcapture-fadeOut 0.3s ease-in 2.5s forwards;
      max-width: 320px;
    `;
    inner.textContent = '⚠ ' + message;
    notificationEl.appendChild(inner);
    document.body.appendChild(notificationEl);
    setTimeout(() => { if (notificationEl) notificationEl.remove(); }, 3000);
  }

  function showCaptureBanner() {
    if (captureBanner) return;
    captureBanner = document.createElement('div');
    captureBanner.id = 'flowcapture-banner';
    captureBanner.style.cssText = `
      position: fixed;
      bottom: 16px;
      left: 50%;
      transform: translateX(-50%);
      background: #6366f1;
      color: white;
      padding: 8px 20px;
      border-radius: 24px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 13px;
      font-weight: 600;
      z-index: 2147483647;
      box-shadow: 0 4px 24px rgba(99,102,241,0.5);
      display: flex;
      align-items: center;
      gap: 8px;
      pointer-events: none;
      letter-spacing: 0.02em;
    `;
    captureBanner.innerHTML = `
      <span style="width:8px;height:8px;background:#ff4444;border-radius:50%;display:inline-block;animation:flowcapture-pulse 1s ease-in-out infinite;"></span>
      FlowCapture recording — click anything to capture a step
    `;
    document.body.appendChild(captureBanner);
  }

  function hideCaptureBanner() {
    if (captureBanner) {
      captureBanner.remove();
      captureBanner = null;
    }
  }

  // ─── Click Handler ───────────────────────────────────────────────

  function handleClick(event) {
    if (!isCapturing) return;
    if (event.target.closest('.flowcapture-notification, .flowcapture-click-ring')) return;

    if (clickDebounceTimer) return;
    clickDebounceTimer = setTimeout(() => { clickDebounceTimer = null; }, 300);

    const el = event.target;
    const rect = el.getBoundingClientRect();

    showClickHighlight(event.clientX, event.clientY);

    setTimeout(() => {
      chrome.runtime.sendMessage({
        type: MSG.CAPTURE_STEP,
        payload: {
          url: window.location.href,
          pageTitle: document.title,
          elementSelector: getElementSelector(el),
          elementText: getElementText(el),
          description: getElementDescription(el),
          elementRect: {
            x: rect.x, y: rect.y,
            width: rect.width, height: rect.height,
          },
          clickPosition: { x: event.clientX, y: event.clientY },
          timestamp: Date.now(),
        },
      }, (response) => {
        if (chrome.runtime.lastError) {
          console.warn('[FlowCapture] Message error:', chrome.runtime.lastError);
          showErrorNotification('Capture failed — try reloading the extension');
          return;
        }
        if (response?.success) {
          showNotification(response.stepNumber);
        } else {
          showErrorNotification(response?.error || 'Capture failed');
        }
      });
    }, 100);
  }

  // ─── Message Listener ────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === MSG.SET_CAPTURING) {
      isCapturing = message.payload.isCapturing;
      document.body.classList.toggle('flowcapture-active', isCapturing);
      if (isCapturing) {
        showCaptureBanner();
      } else {
        hideCaptureBanner();
      }
      sendResponse({ success: true });
    }
    return true;
  });

  // ─── Initialize ──────────────────────────────────────────────────

  function init() {
    try {
      chrome.runtime.sendMessage({ type: MSG.GET_STATE }, (response) => {
        if (chrome.runtime.lastError) return;
        if (response?.success) {
          isCapturing = response.state.isCapturing;
          document.body.classList.toggle('flowcapture-active', isCapturing);
          if (isCapturing) showCaptureBanner();
        }
      });
    } catch (_) {}

    document.addEventListener('click', handleClick, true);
  }

  init();
})();
