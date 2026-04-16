/**
 * FlowCapture Google Drive Sync
 * ===============================
 * Handles authentication and file operations with Google Drive.
 *
 * Architecture:
 *   - Uses chrome.identity.getAuthToken() for OAuth2 (Google Sign-In)
 *   - Stores .flowcapture files in a shared team folder on Drive
 *   - Each SOP = one .flowcapture JSON file in the folder
 *   - Supports upload (save), download (open), list, and delete
 *   - Tracks sync status per SOP (driveFileId, lastSynced, etc.)
 *
 * Scope: drive.file — can only access files created by this app,
 *        plus any files in folders the user explicitly shares.
 *        This is the most restrictive (safest) Drive scope.
 *
 * Usage:
 *   await DriveSync.signIn();
 *   await DriveSync.setTeamFolder(folderId);
 *   await DriveSync.uploadSOP(projectData);
 *   const sops = await DriveSync.listSOPs();
 *   const data = await DriveSync.downloadSOP(fileId);
 */

const DriveSync = {

  STORAGE_KEY: 'flowcapture_drive_config',
  MIME_TYPE: 'application/json',
  FILE_SUFFIX: '.flowcapture',
  FOLDER_NAME: 'FlowCapture SOPs',

  // ─── Auth ────────────────────────────────────────────────────────

  /**
   * Sign in with Google via chrome.identity OAuth2.
   * Returns the access token or throws on failure.
   */
  async signIn(interactive = true) {
    return new Promise((resolve, reject) => {
      chrome.identity.getAuthToken({ interactive }, (token) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (!token) {
          reject(new Error('No token received'));
          return;
        }
        resolve(token);
      });
    });
  },

  /**
   * Sign out — revoke the cached token.
   */
  async signOut() {
    const token = await DriveSync.signIn(false).catch(() => null);
    if (token) {
      // Revoke the token with Google
      await fetch(`https://accounts.google.com/o/oauth2/revoke?token=${token}`).catch(() => {});
      // Remove from Chrome's cache
      await new Promise((resolve) => {
        chrome.identity.removeCachedAuthToken({ token }, resolve);
      });
    }
    // Clear stored config
    await chrome.storage.local.remove(DriveSync.STORAGE_KEY);
  },

  /**
   * Check if user is currently signed in (non-interactive token check).
   */
  async isSignedIn() {
    try {
      await DriveSync.signIn(false);
      return true;
    } catch {
      return false;
    }
  },

  /**
   * Get the user's Google profile info.
   */
  async getUserInfo() {
    const token = await DriveSync.signIn(false);
    const response = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) throw new Error('Failed to get user info');
    return response.json();
  },

  // ─── Config ──────────────────────────────────────────────────────

  async getConfig() {
    const result = await chrome.storage.local.get(DriveSync.STORAGE_KEY);
    return result[DriveSync.STORAGE_KEY] || {};
  },

  async saveConfig(config) {
    const existing = await DriveSync.getConfig();
    await chrome.storage.local.set({
      [DriveSync.STORAGE_KEY]: { ...existing, ...config },
    });
  },

  // ─── Folder Management ───────────────────────────────────────────

  /**
   * Find or create the FlowCapture team folder in the user's Drive.
   * If a folderId is already saved in config, validates it still exists.
   */
  async ensureTeamFolder() {
    const config = await DriveSync.getConfig();

    // Check if saved folder still exists
    if (config.folderId) {
      try {
        const exists = await DriveSync._getFile(config.folderId);
        if (exists && !exists.trashed) return config.folderId;
      } catch {
        // Folder was deleted or inaccessible
      }
    }

    // Search for existing FlowCapture folder
    const token = await DriveSync.signIn(false);
    const query = `name='${DriveSync.FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
    const searchUrl = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id,name)`;

    const searchResp = await fetch(searchUrl, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const searchData = await searchResp.json();

    if (searchData.files && searchData.files.length > 0) {
      const folderId = searchData.files[0].id;
      await DriveSync.saveConfig({ folderId });
      return folderId;
    }

    // Create new folder
    const createResp = await fetch('https://www.googleapis.com/drive/v3/files', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: DriveSync.FOLDER_NAME,
        mimeType: 'application/vnd.google-apps.folder',
      }),
    });

    if (!createResp.ok) throw new Error('Failed to create Drive folder');
    const folder = await createResp.json();
    await DriveSync.saveConfig({ folderId: folder.id });
    return folder.id;
  },

  /**
   * Use a specific folder ID (e.g., a shared team folder).
   */
  async setTeamFolder(folderId) {
    await DriveSync.saveConfig({ folderId });
  },

  // ─── File Operations ─────────────────────────────────────────────

  /**
   * Upload/save an SOP to the team folder.
   * If the SOP already has a driveFileId, it updates the existing file.
   * Otherwise, creates a new file.
   *
   * @param {Object} sopData - The .flowcapture JSON export data
   * @param {string} fileName - e.g., "My_SOP.flowcapture"
   * @param {string} existingFileId - If updating, the Drive file ID
   * @returns {Object} - { fileId, webViewLink }
   */
  async uploadSOP(sopData, fileName, existingFileId = null) {
    const token = await DriveSync.signIn(false);
    const folderId = await DriveSync.ensureTeamFolder();
    const content = JSON.stringify(sopData, null, 2);

    if (existingFileId) {
      // Update existing file
      const response = await fetch(
        `https://www.googleapis.com/upload/drive/v3/files/${existingFileId}?uploadType=media`,
        {
          method: 'PATCH',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': DriveSync.MIME_TYPE,
          },
          body: content,
        }
      );
      if (!response.ok) throw new Error('Failed to update file on Drive');
      const file = await response.json();
      return { fileId: file.id, webViewLink: file.webViewLink };
    }

    // Create new file (multipart upload)
    const metadata = {
      name: fileName,
      mimeType: DriveSync.MIME_TYPE,
      parents: [folderId],
    };

    const boundary = '---flowcapture_boundary---';
    const body = [
      `--${boundary}`,
      'Content-Type: application/json; charset=UTF-8',
      '',
      JSON.stringify(metadata),
      `--${boundary}`,
      `Content-Type: ${DriveSync.MIME_TYPE}`,
      '',
      content,
      `--${boundary}--`,
    ].join('\r\n');

    const response = await fetch(
      'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink,name',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': `multipart/related; boundary=${boundary}`,
        },
        body,
      }
    );

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Upload failed: ${err}`);
    }

    const file = await response.json();
    return { fileId: file.id, webViewLink: file.webViewLink, name: file.name };
  },

  /**
   * List all .flowcapture files in the team folder.
   * Returns array of { id, name, modifiedTime, modifiedByEmail, size }.
   */
  async listSOPs() {
    const token = await DriveSync.signIn(false);
    const folderId = await DriveSync.ensureTeamFolder();

    const query = `'${folderId}' in parents and trashed=false and name contains '.flowcapture'`;
    const fields = 'files(id,name,modifiedTime,size,lastModifyingUser,webViewLink)';
    const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=${fields}&orderBy=modifiedTime desc`;

    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!response.ok) throw new Error('Failed to list Drive files');
    const data = await response.json();

    return (data.files || []).map(f => ({
      id: f.id,
      name: f.name.replace(DriveSync.FILE_SUFFIX, ''),
      fileName: f.name,
      modifiedTime: f.modifiedTime,
      modifiedBy: f.lastModifyingUser?.displayName || 'Unknown',
      modifiedByEmail: f.lastModifyingUser?.emailAddress || '',
      size: f.size,
      webViewLink: f.webViewLink,
    }));
  },

  /**
   * Download a .flowcapture file from Drive and return its parsed contents.
   */
  async downloadSOP(fileId) {
    const token = await DriveSync.signIn(false);
    const url = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;

    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!response.ok) throw new Error('Failed to download file from Drive');
    const data = await response.json();

    if (!data._flowcapture) {
      throw new Error('File is not a valid FlowCapture SOP');
    }

    return data;
  },

  /**
   * Delete a .flowcapture file from Drive (move to trash).
   */
  async deleteSOP(fileId) {
    const token = await DriveSync.signIn(false);
    const response = await fetch(
      `https://www.googleapis.com/drive/v3/files/${fileId}`,
      {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ trashed: true }),
      }
    );
    if (!response.ok) throw new Error('Failed to delete file');
  },

  // ─── Sync Helpers ────────────────────────────────────────────────

  /**
   * Save the current project to Drive.
   * Uses SOPTransfer to build the export data, then uploads.
   */
  async saveCurrentToDrive() {
    // Get steps from background
    const response = await chrome.runtime.sendMessage({ type: 'GET_STEPS' });
    if (!response?.success) throw new Error('Failed to load project');

    const project = response.project;
    const stepsWithImages = response.steps;

    // Build export data (same format as .flowcapture file)
    const exportData = {
      _flowcapture: true,
      formatVersion: '1.0.0',
      exportedAt: new Date().toISOString(),
      exportedBy: 'FlowCapture v1.1 (Drive Sync)',
      project: {
        id: project.id,
        name: project.name,
        description: project.description || '',
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
        settings: project.settings || {},
        approvalStatus: project.approvalStatus || 'draft',
      },
      steps: stepsWithImages.map((step, i) => ({
        id: step.id,
        sequenceNumber: i + 1,
        title: step.title || `Step ${i + 1}`,
        description: step.description || '',
        url: step.url || '',
        timestamp: step.timestamp,
        elementSelector: step.elementSelector || '',
        elementText: step.elementText || '',
        annotations: step.annotations || [],
        role: step.role || 'all',
        agencyNotes: step.agencyNotes || [],
        screenshotDataUrl: step.imageData || null,
      })),
      editHistory: [
        { action: 'synced_to_drive', timestamp: new Date().toISOString(), stepCount: stepsWithImages.length },
      ],
    };

    const fileName = `${project.name.replace(/[^a-zA-Z0-9 _-]/g, '').replace(/\s+/g, '_')}${DriveSync.FILE_SUFFIX}`;

    // Check if this project already has a Drive file
    const config = await DriveSync.getConfig();
    const driveFileMap = config.driveFileMap || {};
    const existingFileId = driveFileMap[project.id] || null;

    const result = await DriveSync.uploadSOP(exportData, fileName, existingFileId);

    // Save the mapping: projectId → driveFileId
    driveFileMap[project.id] = result.fileId;
    await DriveSync.saveConfig({ driveFileMap });

    return result;
  },

  /**
   * Open a Drive SOP and import it into the local extension.
   */
  async openFromDrive(fileId) {
    const data = await DriveSync.downloadSOP(fileId);

    // Use the SOPTransfer import logic
    const jsonStr = JSON.stringify(data);
    const blob = new Blob([jsonStr], { type: 'application/json' });
    const file = new File([blob], 'drive_import.flowcapture');

    const result = await SOPTransfer.importProject(file);

    // Save Drive file mapping
    if (result.project) {
      const config = await DriveSync.getConfig();
      const driveFileMap = config.driveFileMap || {};
      driveFileMap[result.project.id] = fileId;
      await DriveSync.saveConfig({ driveFileMap });
    }

    return result;
  },

  // ─── Internal Helpers ────────────────────────────────────────────

  async _getFile(fileId) {
    const token = await DriveSync.signIn(false);
    const response = await fetch(
      `https://www.googleapis.com/drive/v3/files/${fileId}?fields=id,name,trashed`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!response.ok) return null;
    return response.json();
  },
};

// Make globally available
window.DriveSync = DriveSync;
