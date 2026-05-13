/**
 * FlowCapture Screen Recorder
 * =============================
 * Records screen/tab with optional microphone audio and TTS narration.
 * Uses MediaRecorder API + Web Speech API for text-to-speech.
 */

// Self-contained helpers
function generateId() {
  return crypto.randomUUID ? crypto.randomUUID() :
    'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
}

const DB_CONFIG = { NAME: 'FlowCaptureDB', VERSION: 1 };
async function saveRecording(id, blob, metadata) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_CONFIG.NAME, DB_CONFIG.VERSION);
    request.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('recordings'))
        db.createObjectStore('recordings', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('screenshots'))
        db.createObjectStore('screenshots', { keyPath: 'id' });
    };
    request.onsuccess = (e) => {
      const db = e.target.result;
      const tx = db.transaction('recordings', 'readwrite');
      tx.objectStore('recordings').put({ id, blob, ...metadata, createdAt: Date.now() });
      tx.oncomplete = () => { try { db.close(); } catch (_) {} resolve(); };
      tx.onerror = (err) => { try { db.close(); } catch (_) {} reject(err); };
    };
    request.onerror = (e) => reject(e);
  });
}

// ─── State ───────────────────────────────────────────────────────────

let mediaRecorder = null;
let recordedChunks = [];
let recordingStream = null;
let recordingBlob = null;
let startTime = 0;
let timerInterval = null;
let isPaused = false;
let narrationCues = [];
let cueTimeouts = [];

// ─── DOM Elements ────────────────────────────────────────────────────

const preview = document.getElementById('preview');
const videoOverlay = document.getElementById('videoOverlay');
const timer = document.getElementById('timer');
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const pauseBtn = document.getElementById('pauseBtn');
const ttsText = document.getElementById('ttsText');
const ttsVoice = document.getElementById('ttsVoice');
const ttsRate = document.getElementById('ttsRate');
const rateLabel = document.getElementById('rateLabel');
const speakBtn = document.getElementById('speakBtn');
const stopSpeakBtn = document.getElementById('stopSpeakBtn');
const cuesList = document.getElementById('cuesList');
const cueTime = document.getElementById('cueTime');
const cueText = document.getElementById('cueText');
const addCueBtn = document.getElementById('addCueBtn');
const downloadSection = document.getElementById('downloadSection');
const downloadBtn = document.getElementById('downloadRecording');
const downloadTTSBtn = document.getElementById('downloadWithTTS');

// ─── TTS Voice Setup ─────────────────────────────────────────────────

function loadVoices() {
  const voices = speechSynthesis.getVoices();
  ttsVoice.innerHTML = '';
  voices.forEach((voice, i) => {
    const opt = document.createElement('option');
    opt.value = i;
    opt.textContent = `${voice.name} (${voice.lang})`;
    if (voice.default) opt.selected = true;
    ttsVoice.appendChild(opt);
  });
}

speechSynthesis.onvoiceschanged = loadVoices;
loadVoices();

ttsRate.addEventListener('input', () => {
  rateLabel.textContent = `${ttsRate.value}x`;
});

// ─── TTS Speak ───────────────────────────────────────────────────────

function speak(text) {
  if (!text.trim()) return;
  speechSynthesis.cancel();

  const utterance = new SpeechSynthesisUtterance(text);
  const voices = speechSynthesis.getVoices();
  const selectedVoice = voices[parseInt(ttsVoice.value)];
  if (selectedVoice) utterance.voice = selectedVoice;
  utterance.rate = parseFloat(ttsRate.value);
  utterance.pitch = 1;

  utterance.onstart = () => {
    stopSpeakBtn.disabled = false;
  };
  utterance.onend = () => {
    stopSpeakBtn.disabled = true;
  };

  speechSynthesis.speak(utterance);
}

speakBtn.addEventListener('click', () => speak(ttsText.value));
stopSpeakBtn.addEventListener('click', () => {
  speechSynthesis.cancel();
  stopSpeakBtn.disabled = true;
});

// ─── Narration Cues ──────────────────────────────────────────────────

function parseTime(str) {
  if (!str) return 0;
  const parts = String(str).trim().split(':');
  if (parts.length === 2) {
    const m = parseInt(parts[0], 10);
    const s = parseInt(parts[1], 10);
    if (Number.isNaN(m) || Number.isNaN(s)) return 0;
    return m * 60 + s;
  }
  return parseInt(str, 10) || 0;
}

function formatTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function renderCues() {
  if (narrationCues.length === 0) {
    cuesList.innerHTML = '<div class="empty-cues">No cues added yet</div>';
    return;
  }

  // Sort in place so the rendered indices match the array indices used by
  // the delete buttons. Previously .sort() returned the sorted array but
  // splice() ran against the unsorted `narrationCues`, deleting the wrong row.
  narrationCues.sort((a, b) => a.time - b.time);

  cuesList.innerHTML = narrationCues
    .map((cue, i) => `
      <div class="cue-item">
        <span class="cue-time">${formatTime(cue.time)}</span>
        <span class="cue-text">${escapeHtml(cue.text)}</span>
        <button class="cue-delete" data-index="${i}" title="Remove">&times;</button>
      </div>
    `).join('');

  cuesList.querySelectorAll('.cue-delete').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.index, 10);
      if (Number.isNaN(idx)) return;
      narrationCues.splice(idx, 1);
      renderCues();
    });
  });
}

addCueBtn.addEventListener('click', () => {
  const time = parseTime(cueTime.value);
  const text = cueText.value.trim();
  if (!text) return;

  narrationCues.push({ time, text });
  cueTime.value = '';
  cueText.value = '';
  renderCues();
});

// ─── Timer ───────────────────────────────────────────────────────────

function startTimer() {
  startTime = Date.now();
  timer.classList.add('recording');
  timerInterval = setInterval(() => {
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    const m = Math.floor(elapsed / 60);
    const s = elapsed % 60;
    timer.textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }, 200);
}

function stopTimer() {
  clearInterval(timerInterval);
  timer.classList.remove('recording');
}

// ─── Screen Recording ────────────────────────────────────────────────

async function getStream() {
  const source = document.querySelector('input[name="source"]:checked').value;
  const includeMic = document.getElementById('includeAudio').checked;
  const includeSystem = document.getElementById('includeSystemAudio').checked;

  let screenStream;

  if (source === 'tab') {
    // Tab capture (requires tabCapture permission)
    try {
      screenStream = await new Promise((resolve, reject) => {
        chrome.tabCapture.capture(
          { audio: includeSystem, video: true },
          (stream) => {
            if (stream) resolve(stream);
            else reject(new Error('Tab capture failed'));
          }
        );
      });
    } catch {
      // Fallback to displayMedia
      screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: { cursor: 'always' },
        audio: includeSystem,
      });
    }
  } else {
    // Screen capture
    screenStream = await navigator.mediaDevices.getDisplayMedia({
      video: { cursor: 'always', displaySurface: 'monitor' },
      audio: includeSystem,
    });
  }

  // Add microphone if requested
  if (includeMic) {
    try {
      const micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const tracks = [...screenStream.getTracks(), ...micStream.getAudioTracks()];
      return new MediaStream(tracks);
    } catch (err) {
      console.warn('[FlowCapture] Mic access denied:', err);
    }
  }

  return screenStream;
}

async function startRecording() {
  try {
    recordedChunks = [];
    recordingStream = await getStream();

    // Show preview
    preview.srcObject = recordingStream;
    videoOverlay.classList.add('hidden');

    // Setup MediaRecorder — prefer MP4 when the browser supports it so the
    // recording is upload-ready for Vimeo / Yardi without a conversion step.
    let mimeType;
    if (typeof window.MP4Converter === 'function') {
      const converter = new window.MP4Converter();
      const pick = converter.getBestMimeType(true);
      mimeType = pick.mimeType;
    } else {
      mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
        ? 'video/webm;codecs=vp9'
        : 'video/webm;codecs=vp8';
    }

    mediaRecorder = new MediaRecorder(recordingStream, {
      mimeType,
      videoBitsPerSecond: 2500000,
    });

    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) recordedChunks.push(e.data);
    };

    mediaRecorder.onstop = async () => {
      stopTimer();
      recordingBlob = new Blob(recordedChunks, { type: mimeType });

      // Save to IndexedDB
      const id = generateId();
      await saveRecording(id, recordingBlob, {
        duration: Date.now() - startTime,
        mediaType: mimeType,
        hasAudio: document.getElementById('includeAudio').checked,
      });

      // Show download options
      downloadSection.style.display = '';

      // Update UI
      startBtn.disabled = false;
      stopBtn.disabled = true;
      pauseBtn.disabled = true;
    };

    mediaRecorder.start(1000); // Collect in 1s chunks
    startTimer();

    // Schedule narration cues
    scheduleCues();

    // Handle stream ending (user clicks browser "Stop sharing")
    const videoTrack = recordingStream.getVideoTracks()[0];
    if (videoTrack) {
      videoTrack.onended = () => {
        if (mediaRecorder && mediaRecorder.state !== 'inactive') {
          try { mediaRecorder.stop(); } catch (_) {}
        }
        cleanupStream();
      };
    }

    // Update UI
    startBtn.disabled = true;
    startBtn.classList.add('recording');
    stopBtn.disabled = false;
    pauseBtn.disabled = false;

  } catch (err) {
    console.error('[FlowCapture] Recording failed:', err);
    alert('Failed to start recording. Please check permissions and try again.');
  }
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }
  cleanupStream();
  clearCueTimeouts();
  speechSynthesis.cancel();

  startBtn.classList.remove('recording');
}

function pauseRecording() {
  if (!mediaRecorder) return;

  if (mediaRecorder.state === 'recording') {
    mediaRecorder.pause();
    isPaused = true;
    pauseBtn.innerHTML = `
      <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21"/></svg>
      Resume
    `;
  } else if (mediaRecorder.state === 'paused') {
    mediaRecorder.resume();
    isPaused = false;
    pauseBtn.innerHTML = `
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
      Pause
    `;
  }
}

function cleanupStream() {
  if (recordingStream) {
    recordingStream.getTracks().forEach(t => t.stop());
    recordingStream = null;
  }
  preview.srcObject = null;
  videoOverlay.classList.remove('hidden');
}

// ─── Cue Scheduling ─────────────────────────────────────────────────

function scheduleCues() {
  clearCueTimeouts();
  narrationCues.forEach(cue => {
    const timeout = setTimeout(() => {
      speak(cue.text);
    }, cue.time * 1000);
    cueTimeouts.push(timeout);
  });
}

function clearCueTimeouts() {
  cueTimeouts.forEach(t => clearTimeout(t));
  cueTimeouts = [];
}

// ─── Download Handlers ───────────────────────────────────────────────

function recordingExtension() {
  return recordingBlob && recordingBlob.type.includes('mp4') ? 'mp4' : 'webm';
}

downloadBtn.addEventListener('click', () => {
  if (!recordingBlob) return;
  const url = URL.createObjectURL(recordingBlob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `FlowCapture_Recording_${new Date().toISOString().slice(0, 10)}.${recordingExtension()}`;
  a.click();
  URL.revokeObjectURL(url);
});

downloadTTSBtn.addEventListener('click', () => {
  // Same as regular download (TTS was already captured via system audio or played live)
  if (!recordingBlob) return;
  const url = URL.createObjectURL(recordingBlob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `FlowCapture_Recording_Narrated_${new Date().toISOString().slice(0, 10)}.${recordingExtension()}`;
  a.click();
  URL.revokeObjectURL(url);
});

// ─── Button Events ───────────────────────────────────────────────────

startBtn.addEventListener('click', startRecording);
stopBtn.addEventListener('click', stopRecording);
pauseBtn.addEventListener('click', pauseRecording);

// ─── Graceful shutdown ───────────────────────────────────────────────
// If the user closes the tab mid-recording we must release the screen-capture
// stream (otherwise Chrome shows a persistent "sharing" indicator) and cancel
// any pending TTS cues.

window.addEventListener('beforeunload', () => {
  try { if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop(); } catch (_) {}
  clearCueTimeouts();
  try { speechSynthesis.cancel(); } catch (_) {}
  cleanupStream();
});

// ─── Helpers ─────────────────────────────────────────────────────────

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}
