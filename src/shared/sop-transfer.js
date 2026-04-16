/**
 * FlowCapture SOP Transfer Module
 * =================================
 * Handles export and import of SOP projects as portable .flowcapture files.
 *
 * File format: A single JSON file containing:
 *   - Project metadata (name, description, timestamps, settings)
 *   - Steps with all fields (title, description, URL, element info, etc.)
 *   - Screenshots as base64 data URLs (inlined per step)
 *   - Edit history log
 *   - Format version for future compatibility
 *
 * Usage:
 *   // Export
 *   const blob = await SOPTransfer.exportProject(projectId);
 *   // Import
 *   const project = await SOPTransfer.importProject(fileBlob);
 */

const SOPTransfer = {

  FORMAT_VERSION: '1.0.0',
  FILE_EXTENSION: '.flowcapture',
  MIME_TYPE: 'application/json',

  /**
   * Export the current project as a .flowcapture file blob.
   * Bundles project metadata + all step screenshots into one portable JSON file.
   */
  async exportProject() {
    // Get project and steps with images from background
    const response = await chrome.runtime.sendMessage({ type: 'GET_STEPS' });
    if (!response?.success) throw new Error('Failed to load project data');

    const project = response.project;
    const stepsWithImages = response.steps;

    // Build export payload
    const exportData = {
      // ── Header ──
      _flowcapture: true,
      formatVersion: SOPTransfer.FORMAT_VERSION,
      exportedAt: new Date().toISOString(),
      exportedBy: 'FlowCapture v1.0',

      // ── Project ──
      project: {
        id: project.id,
        name: project.name,
        description: project.description || '',
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
        settings: project.settings || {},
        approvalStatus: project.approvalStatus || 'draft',
      },

      // ── Steps (with screenshots inlined) ──
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
        // Screenshot as base64 data URL — portable, no external refs
        screenshotDataUrl: step.imageData || null,
      })),

      // ── Edit History ──
      editHistory: [
        {
          action: 'exported',
          timestamp: new Date().toISOString(),
          stepCount: stepsWithImages.length,
        },
      ],
    };

    // Create blob
    const json = JSON.stringify(exportData, null, 2);
    const blob = new Blob([json], { type: SOPTransfer.MIME_TYPE });

    return {
      blob,
      filename: `${project.name.replace(/[^a-zA-Z0-9 _-]/g, '').replace(/\s+/g, '_')}_SOP${SOPTransfer.FILE_EXTENSION}`,
      stepCount: stepsWithImages.length,
      sizeMB: (blob.size / 1024 / 1024).toFixed(1),
    };
  },

  /**
   * Trigger a file download for the exported project.
   */
  async downloadExport() {
    const { blob, filename, stepCount, sizeMB } = await SOPTransfer.exportProject();

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);

    return { filename, stepCount, sizeMB };
  },

  /**
   * Import a .flowcapture file and load it into the extension.
   * Returns the imported project with full edit access.
   *
   * @param {File|Blob} file - The .flowcapture file to import
   * @returns {Object} - { project, stepCount, warnings }
   */
  async importProject(file) {
    const text = await file.text();
    let data;

    try {
      data = JSON.parse(text);
    } catch (e) {
      throw new Error('Invalid file format. Expected a .flowcapture JSON file.');
    }

    // Validate format
    if (!data._flowcapture) {
      throw new Error('This file is not a FlowCapture export. Please select a .flowcapture file.');
    }

    const warnings = [];

    // Version check
    if (data.formatVersion !== SOPTransfer.FORMAT_VERSION) {
      warnings.push(`File was created with format v${data.formatVersion}, current is v${SOPTransfer.FORMAT_VERSION}. Some features may differ.`);
    }

    // Generate new IDs to avoid collisions with existing projects
    const newProjectId = crypto.randomUUID();
    const idMap = {}; // old ID → new ID

    const importedSteps = (data.steps || []).map((step, i) => {
      const newStepId = crypto.randomUUID();
      idMap[step.id] = newStepId;

      return {
        id: newStepId,
        sequenceNumber: i + 1,
        title: step.title || `Step ${i + 1}`,
        description: step.description || '',
        url: step.url || '',
        timestamp: step.timestamp || Date.now(),
        elementSelector: step.elementSelector || '',
        elementText: step.elementText || '',
        annotations: step.annotations || [],
        role: step.role || 'all',
        agencyNotes: step.agencyNotes || [],
        screenshotDataUrl: newStepId, // Will point to IndexedDB
        _importedImageData: step.screenshotDataUrl, // Temp: to be stored in IndexedDB
      };
    });

    // Create project object
    const importedProject = {
      id: newProjectId,
      name: data.project?.name ? `${data.project.name} (Imported)` : 'Imported SOP',
      description: data.project?.description || '',
      createdAt: data.project?.createdAt || Date.now(),
      updatedAt: Date.now(),
      steps: importedSteps.map(s => {
        const { _importedImageData, ...step } = s;
        return step;
      }),
      settings: data.project?.settings || { includeUrls: true, exportFormat: 'pdf' },
      approvalStatus: data.project?.approvalStatus || 'draft',
    };

    // ── Store in chrome.storage ──
    const result = await chrome.storage.local.get('flowcapture_projects');
    const projects = result.flowcapture_projects || [];
    projects.push(importedProject);

    await chrome.storage.local.set({
      flowcapture_projects: projects,
      flowcapture_current_project: newProjectId,
    });

    // ── Store screenshots in IndexedDB ──
    const dbName = 'FlowCaptureDB';
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open(dbName, 1);
      req.onupgradeneeded = (e) => {
        const d = e.target.result;
        if (!d.objectStoreNames.contains('screenshots'))
          d.createObjectStore('screenshots', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('recordings'))
          d.createObjectStore('recordings', { keyPath: 'id' });
      };
      req.onsuccess = (e) => resolve(e.target.result);
      req.onerror = (e) => reject(e.target.error);
    });

    for (const step of importedSteps) {
      if (step._importedImageData) {
        await new Promise((resolve, reject) => {
          const tx = db.transaction('screenshots', 'readwrite');
          tx.objectStore('screenshots').put({
            id: step.id,
            dataUrl: step._importedImageData,
            createdAt: Date.now(),
          });
          tx.oncomplete = () => resolve();
          tx.onerror = (e) => reject(e.target.error);
        });
      }
    }

    // Add import event to edit history (stored as project metadata)
    importedProject.editHistory = [
      ...(data.editHistory || []),
      {
        action: 'imported',
        timestamp: new Date().toISOString(),
        originalProjectId: data.project?.id,
        stepCount: importedSteps.length,
      },
    ];

    // Update project with edit history
    const updatedProjects = (await chrome.storage.local.get('flowcapture_projects')).flowcapture_projects || [];
    const idx = updatedProjects.findIndex(p => p.id === newProjectId);
    if (idx !== -1) {
      updatedProjects[idx] = importedProject;
      await chrome.storage.local.set({ flowcapture_projects: updatedProjects });
    }

    return {
      project: importedProject,
      stepCount: importedSteps.length,
      warnings,
      originalName: data.project?.name || 'Unknown',
      exportedAt: data.exportedAt,
    };
  },

  /**
   * Open a file picker dialog and import the selected .flowcapture file.
   * Returns the import result or null if cancelled.
   */
  async promptImport() {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.flowcapture,.json';

      input.onchange = async (e) => {
        const file = e.target.files[0];
        if (!file) { resolve(null); return; }
        try {
          const result = await SOPTransfer.importProject(file);
          resolve(result);
        } catch (err) {
          resolve({ error: err.message });
        }
      };

      input.click();
    });
  },
};

// Make globally available
window.SOPTransfer = SOPTransfer;
