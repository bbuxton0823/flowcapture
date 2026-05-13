/**
 * FlowCapture YouTube Uploader (v1.5)
 * ====================================
 * Handles OAuth + resumable upload to YouTube.
 *
 * Auth flow (per-user, BYO credentials):
 *   1. User creates a Google Cloud project, enables YouTube Data API v3
 *   2. User creates an OAuth 2.0 Client ID (type: Chrome Extension or Web)
 *      - For Chrome extension: redirect URI is https://<extension-id>.chromiumapp.org/
 *   3. User pastes Client ID + Client Secret into FlowCapture Settings
 *   4. User clicks "Authorize YouTube" → opens consent screen via chrome.identity.launchWebAuthFlow
 *   5. We exchange code → refresh + access tokens, store in settings
 *
 * Upload flow (resumable, supports large videos):
 *   1. Refresh access token if expired
 *   2. POST video metadata to /videos endpoint → get upload URL
 *   3. PUT video bytes to upload URL
 *   4. Receive video ID → return embed URL
 */

(function (global) {
  'use strict';

  const SCOPES = [
    'https://www.googleapis.com/auth/youtube.upload',
    'https://www.googleapis.com/auth/youtube.readonly',
  ].join(' ');

  const TOKEN_URL = 'https://oauth2.googleapis.com/token';
  const UPLOAD_URL = 'https://www.googleapis.com/upload/youtube/v3/videos';

  const YouTubeUploader = {
    /**
     * Returns the redirect URI for OAuth. Tell user to add this to
     * their Google Cloud OAuth credentials' "Authorized redirect URIs".
     */
    getRedirectUri() {
      return chrome.identity.getRedirectURL('youtube');
    },

    /**
     * Step 1 of OAuth: launch consent flow, return auth code.
     */
    async authorize(clientId) {
      if (!clientId) throw new Error('Missing YouTube OAuth client ID');

      const redirectUri = this.getRedirectUri();
      const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      authUrl.searchParams.set('client_id', clientId);
      authUrl.searchParams.set('redirect_uri', redirectUri);
      authUrl.searchParams.set('response_type', 'code');
      authUrl.searchParams.set('scope', SCOPES);
      authUrl.searchParams.set('access_type', 'offline');
      authUrl.searchParams.set('prompt', 'consent');

      const responseUrl = await chrome.identity.launchWebAuthFlow({
        url: authUrl.toString(),
        interactive: true,
      });

      if (!responseUrl) throw new Error('YouTube authorization cancelled');

      const url = new URL(responseUrl);
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');
      if (error) throw new Error(`YouTube auth error: ${error}`);
      if (!code) throw new Error('No authorization code returned');
      return code;
    },

    /**
     * Step 2 of OAuth: exchange code for tokens.
     */
    async exchangeCode(clientId, clientSecret, code) {
      const body = new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        grant_type: 'authorization_code',
        redirect_uri: this.getRedirectUri(),
      });
      const res = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Token exchange failed: ${text}`);
      }
      const data = await res.json();
      if (!data.access_token) throw new Error('Token exchange response missing access_token');
      return {
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        tokenExpiresAt: Date.now() + (Math.max(0, Number(data.expires_in) || 0) - 60) * 1000,
      };
    },

    /**
     * Refresh an expired access token.
     */
    async refreshAccessToken(clientId, clientSecret, refreshToken) {
      const body = new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      });
      const res = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });
      if (!res.ok) throw new Error(`Token refresh failed: ${await res.text()}`);
      const data = await res.json();
      if (!data.access_token) throw new Error('Token refresh response missing access_token');
      return {
        accessToken: data.access_token,
        tokenExpiresAt: Date.now() + (Math.max(0, Number(data.expires_in) || 0) - 60) * 1000,
      };
    },

    /**
     * Get a valid access token (refreshes if needed).
     */
    async getValidAccessToken() {
      const settings = await window.FlowCaptureSettings.getSection('youtube');
      if (!settings.refreshToken) {
        throw new Error('YouTube not authorized. Open Settings → Authorize YouTube.');
      }
      if (settings.accessToken && settings.tokenExpiresAt > Date.now()) {
        return settings.accessToken;
      }
      const refreshed = await this.refreshAccessToken(
        settings.clientId,
        settings.clientSecret,
        settings.refreshToken
      );
      await window.FlowCaptureSettings.updateSection('youtube', refreshed);
      return refreshed.accessToken;
    },

    /**
     * Upload a video Blob to YouTube.
     * @param {Blob} videoBlob - The MP4 video blob
     * @param {Object} meta - { title, description, tags[], privacyStatus }
     * @param {Function} onProgress - Called with (percent: 0-100)
     * @returns {Promise<{videoId, watchUrl, embedUrl, embedIframe}>}
     */
    async uploadVideo(videoBlob, meta, onProgress) {
      if (!(videoBlob instanceof Blob) || videoBlob.size === 0) {
        throw new Error('Cannot upload an empty video');
      }
      meta = meta || {};
      const accessToken = await this.getValidAccessToken();
      const allowedPrivacy = ['public', 'unlisted', 'private'];
      const privacyStatus = allowedPrivacy.includes(meta.privacyStatus) ? meta.privacyStatus : 'unlisted';

      const metadata = {
        snippet: {
          title: meta.title || 'Untitled SOP',
          description: meta.description || '',
          tags: meta.tags || ['SOP', 'Training', 'HACSM'],
          categoryId: '27', // Education
        },
        status: {
          privacyStatus,
          selfDeclaredMadeForKids: false,
        },
      };

      // Step 1: initiate resumable upload
      const initRes = await fetch(
        `${UPLOAD_URL}?uploadType=resumable&part=snippet,status`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json; charset=UTF-8',
            'X-Upload-Content-Type': videoBlob.type || 'video/mp4',
            'X-Upload-Content-Length': String(videoBlob.size),
          },
          body: JSON.stringify(metadata),
        }
      );

      if (!initRes.ok) {
        throw new Error(`YouTube init failed: ${await initRes.text()}`);
      }

      const uploadUrl = initRes.headers.get('Location');
      if (!uploadUrl) throw new Error('YouTube did not return an upload URL');

      // Step 2: upload bytes (use XHR for progress events)
      const uploadResult = await uploadWithProgress(
        uploadUrl,
        videoBlob,
        onProgress
      );

      const videoId = uploadResult.id;
      if (!videoId) throw new Error('YouTube did not return a video ID');

      return {
        videoId,
        watchUrl: `https://www.youtube.com/watch?v=${videoId}`,
        embedUrl: `https://www.youtube.com/embed/${videoId}`,
        embedIframe: `<iframe width="800" height="450" src="https://www.youtube.com/embed/${videoId}" title="${escapeHtml(meta.title || 'SOP')}" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe>`,
      };
    },

    /**
     * Quick test of stored credentials (token refresh).
     */
    async testConnection() {
      try {
        await this.getValidAccessToken();
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    },
  };

  function uploadWithProgress(url, blob, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', url);
      xhr.setRequestHeader('Content-Type', blob.type || 'video/mp4');
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && typeof onProgress === 'function') {
          onProgress(Math.round((e.loaded / e.total) * 100));
        }
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            resolve(JSON.parse(xhr.responseText));
          } catch (e) {
            reject(new Error('Invalid response from YouTube'));
          }
        } else {
          reject(new Error(`Upload failed (${xhr.status}): ${xhr.responseText}`));
        }
      };
      xhr.onerror = () => reject(new Error('Network error during upload'));
      xhr.send(blob);
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  global.FlowCaptureYouTube = YouTubeUploader;
})(typeof window !== 'undefined' ? window : self);
