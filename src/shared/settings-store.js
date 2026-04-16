/**
 * FlowCapture Settings Store (v1.5)
 * ==================================
 * Centralized API key + integration storage. All keys live in
 * chrome.storage.local — per-user, per-machine, NEVER synced to cloud.
 *
 * Each PCO supplies their own credentials. Nothing is baked into the extension.
 *
 * Storage keys:
 *   flowcapture_settings = {
 *     elevenLabs: { apiKey, defaultVoiceId, defaultModel },
 *     youtube:    { clientId, clientSecret, refreshToken, accessToken, tokenExpiresAt },
 *     vimeo:      { accessToken },
 *     defaults:   { privacy: 'unlisted', autoCaptions: true }
 *   }
 */

(function (global) {
  'use strict';

  const STORAGE_KEY = 'flowcapture_settings';

  const DEFAULT_SETTINGS = {
    elevenLabs: {
      apiKey: '',
      defaultVoiceId: '',
      defaultModel: 'eleven_multilingual_v2',
    },
    youtube: {
      clientId: '',
      clientSecret: '',
      refreshToken: '',
      accessToken: '',
      tokenExpiresAt: 0,
    },
    vimeo: {
      accessToken: '',
    },
    defaults: {
      privacy: 'unlisted', // 'unlisted' | 'private' | 'public'
      autoCaptions: true,
    },
  };

  const SettingsStore = {
    /**
     * Get all settings (with defaults filled in for missing fields).
     */
    async getAll() {
      const result = await chrome.storage.local.get(STORAGE_KEY);
      const stored = result[STORAGE_KEY] || {};
      return mergeDeep(DEFAULT_SETTINGS, stored);
    },

    /**
     * Get a specific section.
     */
    async getSection(section) {
      const all = await this.getAll();
      return all[section] || {};
    },

    /**
     * Update one section (merges with existing).
     */
    async updateSection(section, patch) {
      const all = await this.getAll();
      all[section] = { ...(all[section] || {}), ...patch };
      await chrome.storage.local.set({ [STORAGE_KEY]: all });
      return all[section];
    },

    /**
     * Wipe all settings (for "Disconnect everything" button).
     */
    async clearAll() {
      await chrome.storage.local.remove(STORAGE_KEY);
    },

    /**
     * Wipe a single section.
     */
    async clearSection(section) {
      const all = await this.getAll();
      all[section] = DEFAULT_SETTINGS[section];
      await chrome.storage.local.set({ [STORAGE_KEY]: all });
    },

    /**
     * Quick test: do we have an ElevenLabs key configured?
     */
    async hasElevenLabs() {
      const s = await this.getSection('elevenLabs');
      return !!(s.apiKey && s.apiKey.trim());
    },

    async hasYouTube() {
      const s = await this.getSection('youtube');
      return !!(s.refreshToken || s.accessToken);
    },

    async hasVimeo() {
      const s = await this.getSection('vimeo');
      return !!(s.accessToken && s.accessToken.trim());
    },
  };

  function mergeDeep(target, source) {
    const out = Array.isArray(target) ? [...target] : { ...target };
    for (const key in source) {
      if (
        source[key] &&
        typeof source[key] === 'object' &&
        !Array.isArray(source[key])
      ) {
        out[key] = mergeDeep(target[key] || {}, source[key]);
      } else if (source[key] !== undefined) {
        out[key] = source[key];
      }
    }
    return out;
  }

  global.FlowCaptureSettings = SettingsStore;
})(typeof window !== 'undefined' ? window : self);
