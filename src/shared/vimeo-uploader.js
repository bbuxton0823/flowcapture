/**
 * FlowCapture Vimeo Uploader (v1.5)
 * ==================================
 * Upload videos to Vimeo using the tus resumable protocol.
 *
 * Auth:
 *   User generates a Personal Access Token at https://developer.vimeo.com/apps
 *   with scopes: upload, edit, delete, video_files, public, private
 *   Pastes token into FlowCapture Settings.
 *
 * Upload flow:
 *   1. POST /me/videos with { upload: { approach: 'tus', size } } → get upload_link
 *   2. PATCH upload_link with the video bytes (Tus protocol)
 *   3. Optionally set privacy to 'unlisted' (Plus+ accounts) or 'disable' (private)
 */

(function (global) {
  'use strict';

  const API_BASE = 'https://api.vimeo.com';

  const VimeoUploader = {
    /**
     * Quick test of token validity.
     */
    async testConnection() {
      try {
        const token = await this._getToken();
        const res = await fetch(`${API_BASE}/me`, {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.vimeo.*+json;version=3.4',
          },
        });
        if (!res.ok) {
          return { ok: false, error: `Vimeo API ${res.status}: ${await res.text()}` };
        }
        const me = await res.json();
        return { ok: true, user: me.name, account: me.account };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    },

    /**
     * Upload a video Blob to Vimeo using tus resumable upload.
     * @param {Blob} videoBlob - The MP4 video blob
     * @param {Object} meta - { title, description, privacy }  (privacy: 'anybody'|'unlisted'|'disable')
     * @param {Function} onProgress - Called with (percent: 0-100)
     * @returns {Promise<{videoId, watchUrl, embedUrl, embedIframe}>}
     */
    async uploadVideo(videoBlob, meta, onProgress) {
      if (!(videoBlob instanceof Blob) || videoBlob.size === 0) {
        throw new Error('Cannot upload an empty video');
      }
      meta = meta || {};
      const token = await this._getToken();
      const allowedPrivacy = ['anybody', 'unlisted', 'disable'];
      const privacy = allowedPrivacy.includes(meta.privacy) ? meta.privacy : 'unlisted';

      // Step 1: create video resource + get tus upload link
      const createRes = await fetch(`${API_BASE}/me/videos`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/vnd.vimeo.*+json;version=3.4',
        },
        body: JSON.stringify({
          upload: {
            approach: 'tus',
            size: String(videoBlob.size),
          },
          name: meta.title || 'Untitled SOP',
          description: meta.description || '',
          privacy: { view: privacy },
        }),
      });

      if (!createRes.ok) {
        throw new Error(`Vimeo create failed: ${await createRes.text()}`);
      }

      const createData = await createRes.json();
      const uploadLink = createData.upload?.upload_link;
      const videoUri = createData.uri; // /videos/123456789
      if (!uploadLink || !videoUri) {
        throw new Error('Vimeo did not return an upload link');
      }
      const videoId = videoUri.split('/').pop();

      // Step 2: PATCH bytes via tus
      await tusUpload(uploadLink, videoBlob, onProgress);

      return {
        videoId,
        watchUrl: `https://vimeo.com/${videoId}`,
        embedUrl: `https://player.vimeo.com/video/${videoId}`,
        embedIframe: `<iframe src="https://player.vimeo.com/video/${videoId}" width="800" height="450" frameborder="0" allow="autoplay; fullscreen; picture-in-picture" allowfullscreen title="${escapeHtml(meta.title || 'SOP')}"></iframe>`,
      };
    },

    async _getToken() {
      const settings = await window.FlowCaptureSettings.getSection('vimeo');
      if (!settings.accessToken) {
        throw new Error('Vimeo not configured. Open Settings → paste Vimeo access token.');
      }
      return settings.accessToken;
    },
  };

  /**
   * Tus 1.0 upload — PATCH bytes with Upload-Offset until done.
   * For most videos under ~1GB we can do a single PATCH.
   */
  async function tusUpload(uploadLink, blob, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PATCH', uploadLink);
      xhr.setRequestHeader('Tus-Resumable', '1.0.0');
      xhr.setRequestHeader('Upload-Offset', '0');
      xhr.setRequestHeader('Content-Type', 'application/offset+octet-stream');
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && typeof onProgress === 'function') {
          onProgress(Math.round((e.loaded / e.total) * 100));
        }
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(true);
        } else {
          reject(new Error(`Vimeo tus upload failed (${xhr.status}): ${xhr.responseText}`));
        }
      };
      xhr.onerror = () => reject(new Error('Vimeo network error during upload'));
      xhr.send(blob);
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  global.FlowCaptureVimeo = VimeoUploader;
})(typeof window !== 'undefined' ? window : self);
