/**
 * FlowCapture Logger
 * ===================
 * Tiny structured logger. Wraps console.* so we can:
 *   - prefix every message consistently
 *   - silence below a chosen level in production
 *   - swap out for a remote sink later if needed
 *
 * Usage:
 *   const log = window.FCLog.scope('background');
 *   log.info('Service worker loaded');
 *   log.warn('Tab capture fallback', { tabId });
 *   log.error('IndexedDB open failed', err);
 *
 * Levels (low → high): debug, info, warn, error.
 * Set window.FC_LOG_LEVEL = 'warn' before scripts load to suppress lower levels.
 */
(function (global) {
  'use strict';

  const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };
  const DEFAULT_LEVEL = 'info';

  function currentLevel() {
    const fromGlobal = global.FC_LOG_LEVEL;
    return LEVELS[fromGlobal] != null ? LEVELS[fromGlobal] : LEVELS[DEFAULT_LEVEL];
  }

  function emit(method, scope, args) {
    const prefix = `[FlowCapture${scope ? ':' + scope : ''}]`;
    try {
      // eslint-disable-next-line no-console
      console[method](prefix, ...args);
    } catch (_) {
      // Console not available (rare). Silently drop.
    }
  }

  function makeLogger(scope) {
    return {
      debug(...args) { if (currentLevel() <= LEVELS.debug) emit('debug', scope, args); },
      info(...args)  { if (currentLevel() <= LEVELS.info)  emit('log',   scope, args); },
      warn(...args)  { if (currentLevel() <= LEVELS.warn)  emit('warn',  scope, args); },
      error(...args) { if (currentLevel() <= LEVELS.error) emit('error', scope, args); },
      scope(child)   { return makeLogger(scope ? `${scope}/${child}` : child); },
    };
  }

  global.FCLog = makeLogger('');
})(typeof window !== 'undefined' ? window : self);
