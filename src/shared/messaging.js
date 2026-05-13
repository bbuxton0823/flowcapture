/**
 * FlowCapture Messaging Helper
 * =============================
 * MV3 service workers suspend after ~30s idle. The first message after
 * wake-up can fail with "Could not establish connection. Receiving end does
 * not exist." even though the SW will be up by the time we retry.
 *
 * sendMessageWithRetry wraps chrome.runtime.sendMessage with a tiny retry
 * loop so pages other than popup.js (which had its own copy) survive the
 * suspension cycle without spurious errors.
 */
(function () {
  'use strict';

  async function sendMessageWithRetry(message, { attempts = 3, delayMs = 200 } = {}) {
    let lastErr = null;
    for (let i = 0; i < attempts; i++) {
      try {
        return await chrome.runtime.sendMessage(message);
      } catch (err) {
        lastErr = err;
        const msg = err?.message || '';
        const transient = msg.includes('Receiving end does not exist')
          || msg.includes('Could not establish connection')
          || msg.includes('Extension context invalidated');
        if (!transient || i === attempts - 1) throw err;
        // Linear backoff is enough — the SW wakes in well under a second.
        await new Promise((r) => setTimeout(r, delayMs * (i + 1)));
      }
    }
    throw lastErr;
  }

  window.FlowCaptureMessaging = { sendMessageWithRetry };
})();
