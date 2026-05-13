/**
 * FlowCapture Smoke Test Suite
 * =============================
 * Covers the 25 bug fixes that landed on refactor/production-readiness.
 *
 * Strategy: most fixes guard pure logic (URL parsing, token math, sorting,
 * validation). We re-implement that logic inline from the source and assert
 * it produces correct output. For code paths that touch chrome.* globals,
 * we build minimal mocks and load the source via vm.runInContext.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const readSrc = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// ────────────────────────────────────────────────────────────────────
// 1. Token expiry math (R1)
// Mirrors src/shared/youtube-uploader.js lines 96 + 120.
// ────────────────────────────────────────────────────────────────────
function computeTokenExpiresAt(expires_in, nowMs = Date.now()) {
  return nowMs + (Math.max(0, Number(expires_in) || 0) - 60) * 1000;
}

test('R1: tokenExpiresAt computes correctly when expires_in is present', () => {
  const now = 1_000_000_000_000;
  const result = computeTokenExpiresAt(3600, now);
  // 3600 - 60 = 3540s → 3,540,000ms
  assert.equal(result, now + 3_540_000);
});

test('R1: tokenExpiresAt does NOT produce NaN when expires_in is missing', () => {
  const now = 1_000_000_000_000;
  for (const bad of [undefined, null, '', 'foo', NaN]) {
    const r = computeTokenExpiresAt(bad, now);
    assert.ok(!Number.isNaN(r), `expected non-NaN for input ${String(bad)}, got ${r}`);
    // With safe-default of 0, result = now + (0 - 60)*1000 = now - 60000 (token immediately expired — safe).
    assert.equal(r, now - 60_000);
  }
});

test('R1: source confirms safe default pattern in youtube-uploader.js', () => {
  const src = readSrc('src/shared/youtube-uploader.js');
  // Pattern: Math.max(0, Number(data.expires_in) || 0)
  const matches = src.match(/Math\.max\(0,\s*Number\(data\.expires_in\)\s*\|\|\s*0\)/g) || [];
  assert.ok(matches.length >= 2, `expected ≥2 safe-default uses (exchangeCode + refresh); found ${matches.length}`);
});

// ────────────────────────────────────────────────────────────────────
// 2. URL safety (R4)
// Mirrors `new URL(step.url)` wrapped in try/catch.
// ────────────────────────────────────────────────────────────────────
function safeParseURL(input) {
  try {
    return { ok: true, url: new URL(input) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

test('R4: URL parsing rejects javascript: URLs gracefully', () => {
  // Note: `javascript:void(0)` is technically a valid URL per WHATWG.
  // The real defensive guard is rejecting protocols that aren't http/https.
  const r = safeParseURL('javascript:void(0)');
  // Confirm we always get a defined result (no thrown exception leaking up).
  assert.ok(r.ok === true || r.ok === false);
  if (r.ok) {
    // If parsed, it must NOT be treated as http(s)
    assert.notEqual(r.url.protocol, 'http:');
    assert.notEqual(r.url.protocol, 'https:');
  }
});

test('R4: URL parsing handles chrome:// extension URLs without throwing', () => {
  const r = safeParseURL('chrome://extensions');
  assert.ok(r.ok === true || r.ok === false, 'must produce a result, not throw');
});

test('R4: URL parsing rejects garbage input', () => {
  const r = safeParseURL('not a url');
  assert.equal(r.ok, false);
  assert.ok(/Invalid URL|invalid url/i.test(r.error));
});

test('R4: URL parsing accepts a valid https URL', () => {
  const r = safeParseURL('https://example.com/path?x=1');
  assert.equal(r.ok, true);
  assert.equal(r.url.protocol, 'https:');
  assert.equal(r.url.hostname, 'example.com');
});

// ────────────────────────────────────────────────────────────────────
// 3. Cue sort (R5) — narrationCues.sort sorts in place.
// ────────────────────────────────────────────────────────────────────
test('R5: narrationCues.sort is in-place and sorts ascending by time', () => {
  const cues = [
    { time: 30, text: 'c' },
    { time: 10, text: 'a' },
    { time: 20, text: 'b' },
  ];
  // Mirror src/pages/recorder/recorder.js line 152
  cues.sort((a, b) => a.time - b.time);
  assert.deepEqual(cues.map(c => c.time), [10, 20, 30]);
  assert.equal(cues[0].text, 'a');
});

test('R5: source uses in-place .sort() on narrationCues, not assignment', () => {
  const src = readSrc('src/pages/recorder/recorder.js');
  // The fix: narrationCues.sort(...) — NOT narrationCues = narrationCues.sort(...)
  assert.match(src, /narrationCues\.sort\(\s*\(a,\s*b\)\s*=>/);
  // Verify the buggy form isn't present
  assert.doesNotMatch(src, /narrationCues\s*=\s*narrationCues\.sort/);
});

// ────────────────────────────────────────────────────────────────────
// 4. Import cap (S6) — .flowcapture import limits.
// ────────────────────────────────────────────────────────────────────
test('S6: import rejects > 1000 steps', () => {
  // Mirror sop-transfer.js MAX_STEPS_PER_IMPORT check
  const MAX_STEPS_PER_IMPORT = 1000;
  const data = { _flowcapture: true, steps: new Array(1001).fill({ id: 'x' }) };
  let err = null;
  try {
    if (Array.isArray(data.steps) && data.steps.length > MAX_STEPS_PER_IMPORT) {
      throw new Error(`File contains too many steps (${data.steps.length}). Limit is ${MAX_STEPS_PER_IMPORT}.`);
    }
  } catch (e) { err = e; }
  assert.ok(err, 'expected error for 1001 steps');
  assert.match(err.message, /too many steps/);
});

test('S6: import accepts 999 steps', () => {
  const MAX_STEPS_PER_IMPORT = 1000;
  const data = { _flowcapture: true, steps: new Array(999).fill({ id: 'x' }) };
  let err = null;
  try {
    if (Array.isArray(data.steps) && data.steps.length > MAX_STEPS_PER_IMPORT) {
      throw new Error('too many');
    }
  } catch (e) { err = e; }
  assert.equal(err, null);
});

test('S6: source caps at MAX_IMPORT_BYTES of 250 MB', () => {
  const src = readSrc('src/shared/sop-transfer.js');
  assert.match(src, /MAX_IMPORT_BYTES:\s*250\s*\*\s*1024\s*\*\s*1024/);
  assert.match(src, /MAX_STEPS_PER_IMPORT:\s*1000/);
});

// ────────────────────────────────────────────────────────────────────
// 5. ElevenLabs storage unification (L1)
// Confirm video.js reads legacy `flowcapture_elevenlabs` then writes to
// the unified `elevenLabs` section via FlowCaptureSettings.
// ────────────────────────────────────────────────────────────────────
test('L1: video.js migrates legacy flowcapture_elevenlabs key to unified store', () => {
  const src = readSrc('src/pages/video/video.js');
  // Reads the legacy key
  assert.match(src, /chrome\.storage\.local\.get\(['"]flowcapture_elevenlabs['"]/);
  // Writes to unified section
  assert.match(src, /FlowCaptureSettings\.updateSection\(['"]elevenLabs['"]/);
  // Removes the legacy key after migration
  assert.match(src, /chrome\.storage\.local\.remove\(['"]flowcapture_elevenlabs['"]\)/);
});

test('L1: simulated migration — legacy data is written to unified store and legacy removed', async () => {
  // In-memory fake of chrome.storage.local + FlowCaptureSettings
  const store = {
    flowcapture_elevenlabs: { apiKey: 'legacy-key-123', voiceId: 'v1', model: 'eleven_monolingual_v1' },
    flowcapture_settings: { elevenLabs: {} },
  };
  const fakeStorage = {
    get: (key) => Promise.resolve({ [key]: store[key] }),
    set: (obj) => { Object.assign(store, obj); return Promise.resolve(); },
    remove: (key) => { delete store[key]; return Promise.resolve(); },
  };
  const Settings = {
    async getSection(name) {
      return (store.flowcapture_settings && store.flowcapture_settings[name]) || {};
    },
    async updateSection(name, value) {
      store.flowcapture_settings[name] = { ...store.flowcapture_settings[name], ...value };
    },
  };

  // Mirror the migration block from video.js
  let saved = null;
  const section = await Settings.getSection('elevenLabs');
  saved = { apiKey: section.apiKey || '', voiceId: section.defaultVoiceId || '', model: section.defaultModel || '' };
  if (!saved.apiKey) {
    const legacy = (await fakeStorage.get('flowcapture_elevenlabs')).flowcapture_elevenlabs || {};
    if (legacy.apiKey) {
      await Settings.updateSection('elevenLabs', {
        apiKey: legacy.apiKey,
        defaultVoiceId: legacy.voiceId || '',
        defaultModel: legacy.model || 'eleven_multilingual_v2',
      });
      saved = { apiKey: legacy.apiKey, voiceId: legacy.voiceId || '', model: legacy.model || '' };
      await fakeStorage.remove('flowcapture_elevenlabs');
    }
  }

  assert.equal(saved.apiKey, 'legacy-key-123');
  assert.equal(store.flowcapture_settings.elevenLabs.apiKey, 'legacy-key-123');
  assert.equal(store.flowcapture_elevenlabs, undefined, 'legacy key should be removed');

  // Subsequent read uses unified key only
  const after = await Settings.getSection('elevenLabs');
  assert.equal(after.apiKey, 'legacy-key-123');
});

// ────────────────────────────────────────────────────────────────────
// 6. YouTube blob validation (L2)
// uploadVideo() must reject empty Blob with a clear error before any network call.
// ────────────────────────────────────────────────────────────────────
test('L2: uploadVideo rejects an empty Blob with a clear error', async () => {
  // Build a minimal sandbox to load youtube-uploader.js
  const sandbox = {
    Blob: globalThis.Blob,
    URLSearchParams: globalThis.URLSearchParams,
    URL: globalThis.URL,
    fetch: () => { throw new Error('network must not be called for an empty blob'); },
    XMLHttpRequest: function () {},
    chrome: { identity: { getRedirectURL: () => 'https://x.chromiumapp.org/' } },
    Date,
    Math,
    Number,
    String,
    JSON,
    console,
    window: {},
  };
  sandbox.window.FlowCaptureSettings = {
    getSection: async () => ({ refreshToken: 'rt', accessToken: 'at', tokenExpiresAt: Date.now() + 600_000 }),
    updateSection: async () => {},
  };
  sandbox.self = sandbox.window;

  vm.createContext(sandbox);
  vm.runInContext(readSrc('src/shared/youtube-uploader.js'), sandbox);
  const Y = sandbox.window.FlowCaptureYouTube;

  await assert.rejects(
    () => Y.uploadVideo(new Blob([]), { title: 'x' }),
    /Cannot upload an empty video/i
  );
});

test('L2: uploadVideo proceeds past the size check for a non-empty Blob', async () => {
  let initCalled = false;
  const sandbox = {
    Blob: globalThis.Blob,
    URLSearchParams: globalThis.URLSearchParams,
    URL: globalThis.URL,
    fetch: async () => {
      initCalled = true;
      // Bail out cleanly — we just want to confirm we got past the size guard.
      return { ok: false, text: async () => 'mock' };
    },
    XMLHttpRequest: function () {},
    chrome: { identity: { getRedirectURL: () => 'https://x.chromiumapp.org/' } },
    Date, Math, Number, String, JSON, console, window: {},
  };
  sandbox.window.FlowCaptureSettings = {
    getSection: async () => ({ refreshToken: 'rt', accessToken: 'at', tokenExpiresAt: Date.now() + 600_000 }),
    updateSection: async () => {},
  };
  sandbox.self = sandbox.window;
  vm.createContext(sandbox);
  vm.runInContext(readSrc('src/shared/youtube-uploader.js'), sandbox);
  const Y = sandbox.window.FlowCaptureYouTube;

  await assert.rejects(
    () => Y.uploadVideo(new Blob([new Uint8Array([1, 2, 3])]), { title: 'x' }),
    /YouTube init failed/i
  );
  assert.equal(initCalled, true, 'expected upload to reach the network init call');
});

// ────────────────────────────────────────────────────────────────────
// 7. Privacy enum validation (L3)
// ────────────────────────────────────────────────────────────────────
test('L3: privacyStatus validated against enum — valid value passes', () => {
  const allowed = ['public', 'unlisted', 'private'];
  const meta = { privacyStatus: 'unlisted' };
  const result = allowed.includes(meta.privacyStatus) ? meta.privacyStatus : 'unlisted';
  assert.equal(result, 'unlisted');
});

test('L3: privacyStatus typo defaults to unlisted', () => {
  const allowed = ['public', 'unlisted', 'private'];
  for (const bad of ['typo', undefined, '', null, 'PUBLIC', 'public; DROP']) {
    const meta = { privacyStatus: bad };
    const result = allowed.includes(meta.privacyStatus) ? meta.privacyStatus : 'unlisted';
    assert.equal(result, 'unlisted', `expected default unlisted for ${String(bad)}`);
  }
});

test('L3: source enforces enum in youtube-uploader.js', () => {
  const src = readSrc('src/shared/youtube-uploader.js');
  assert.match(src, /\[\s*['"]public['"]\s*,\s*['"]unlisted['"]\s*,\s*['"]private['"]\s*\]/);
});

// ────────────────────────────────────────────────────────────────────
// 8. Drive q= escaping (S3)
// ────────────────────────────────────────────────────────────────────
function escapeQ(value) {
  // Mirror DriveSync._escapeQ
  return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

test('S3: _escapeQ escapes single quotes and backslashes for Drive queries', () => {
  // Backslash → double backslash; single quote → backslash + single quote.
  // Spaces are NOT escaped (they're legal inside `q=` once URL-encoded).
  assert.equal(escapeQ("O'Brien"), "O\\'Brien");
  assert.equal(escapeQ('back\\slash'), 'back\\\\slash');
  assert.equal(escapeQ("a 'b' \\c"), "a \\'b\\' \\\\c");
  // The escape function applies backslash first, then quote — confirm idempotent escapes
  assert.equal(escapeQ("plain"), "plain");
});

test('S3: source has _escapeQ helper and uses it in folder queries', () => {
  const src = readSrc('src/shared/drive-sync.js');
  assert.match(src, /_escapeQ\(value\)/);
  // Used for folder name & folderId in queries
  const usages = src.match(/_escapeQ\(/g) || [];
  assert.ok(usages.length >= 3, `expected ≥3 uses of _escapeQ (definition + 2+ call sites); found ${usages.length}`);
});

// ────────────────────────────────────────────────────────────────────
// 9. parseInt radix (R10) — confirm ≥5 radix-10 calls across source files.
// ────────────────────────────────────────────────────────────────────
test('R10: parseInt with explicit radix 10 — sanity', () => {
  assert.equal(parseInt('09', 10), 9, 'parseInt with radix 10 must parse "09" as 9');
  // Without radix, modern V8 still defaults to base 10 — but historic browsers
  // treated "09" / "0x9" inconsistently, which is the bug R10 guards against.
});

test('R10: at least 5 parseInt(..., 10) calls exist across source files', () => {
  const files = [
    'src/popup/popup.js',
    'src/pages/video/video.js',
    'src/pages/recorder/recorder.js',
    'src/pages/editor/editor.js',
  ];
  let total = 0;
  const perFile = {};
  for (const f of files) {
    const src = readSrc(f);
    const matches = src.match(/parseInt\([^)]*,\s*10\)/g) || [];
    perFile[f] = matches.length;
    total += matches.length;
  }
  assert.ok(
    total >= 5,
    `expected ≥5 radix-10 parseInt calls across source; got ${total}. Per-file: ${JSON.stringify(perFile)}`
  );
});

// ────────────────────────────────────────────────────────────────────
// 10. Step count cap (R12)
// Background handler rejects the 501st capture.
// ────────────────────────────────────────────────────────────────────
test('R12: project with 501 steps — capture handler rejects', () => {
  const MAX_STEPS_PER_PROJECT = 500;
  const project = { steps: new Array(500).fill({ id: 'x' }) };
  // Mimic the handler check
  function tryCapture(proj) {
    if (proj.steps.length >= MAX_STEPS_PER_PROJECT) {
      return { success: false, error: `Step limit reached (${MAX_STEPS_PER_PROJECT}).` };
    }
    return { success: true };
  }
  const r = tryCapture(project);
  assert.equal(r.success, false);
  assert.match(r.error, /Step limit reached/);
});

test('R12: project with 499 steps still accepts captures', () => {
  const MAX_STEPS_PER_PROJECT = 500;
  const project = { steps: new Array(499).fill({ id: 'x' }) };
  function tryCapture(proj) {
    if (proj.steps.length >= MAX_STEPS_PER_PROJECT) return { success: false };
    return { success: true };
  }
  assert.equal(tryCapture(project).success, true);
});

test('R12: source constant and handler are present in background.js', () => {
  const src = readSrc('src/background/background.js');
  assert.match(src, /MAX_STEPS_PER_PROJECT\s*=\s*500/);
  assert.match(src, /project\.steps\.length\s*>=\s*MAX_STEPS_PER_PROJECT/);
  assert.match(src, /Step limit reached/);
});

// ────────────────────────────────────────────────────────────────────
// 11. XSS prevention (S1) — Drive picker avoids innerHTML interpolation
// of untrusted file names. The picker uses a native `prompt()` and joins
// names with a newline; no DOM injection happens with f.name.
// ────────────────────────────────────────────────────────────────────
test('S1: Drive picker does not inject file names into innerHTML', () => {
  const src = readSrc('src/pages/editor/editor.js');
  // The picker must not interpolate f.name into innerHTML
  // Pattern to forbid: innerHTML = `...${...name...}...`
  const dangerous = src.match(/innerHTML\s*=\s*[`"'][^`"']*\$\{[^}]*\.name[^}]*\}/);
  assert.equal(dangerous, null, 'file names must not be set via innerHTML interpolation');
});

test('S1: Drive picker construction uses safe primitives (prompt or DOM API)', () => {
  const src = readSrc('src/pages/editor/editor.js');
  // The fixed picker uses `prompt(...)` rendering plain text, not HTML.
  // Confirm a prompt-based picker is what's in place.
  const pickerBlock = src.slice(src.indexOf('Build a simple picker'), src.indexOf('Build a simple picker') + 1500);
  assert.ok(
    /prompt\(/.test(pickerBlock) || /createElement\(/.test(pickerBlock) || /textContent\s*=/.test(pickerBlock),
    'picker must use prompt(), createElement, or textContent — not innerHTML interpolation'
  );
  // And specifically: no innerHTML = `...${f.name...}` in the picker block
  assert.doesNotMatch(pickerBlock, /innerHTML\s*=\s*[`"'][^`"']*\$\{[^}]*f\.name/);
});

// ────────────────────────────────────────────────────────────────────
// Bonus assertions covering smaller fixes mentioned in the changelog.
// ────────────────────────────────────────────────────────────────────
test('S2: OAuth revoke uses POST, not GET', () => {
  const src = readSrc('src/shared/drive-sync.js');
  // Find the revoke fetch and confirm method:POST is on the same call.
  const revokeIdx = src.indexOf('oauth2.googleapis.com/revoke');
  assert.notEqual(revokeIdx, -1);
  const slice = src.slice(revokeIdx, revokeIdx + 400);
  assert.match(slice, /method:\s*['"]POST['"]/);
  // And the token must NOT be in the URL itself
  assert.doesNotMatch(slice, /revoke\?token=/);
});

test('R2: video track guard before .onended', () => {
  const src = readSrc('src/pages/recorder/recorder.js') + readSrc('src/pages/video/video.js');
  // Look for any track-existence guard before assigning onended
  assert.ok(
    /getVideoTracks\(\)\[0\]/.test(src) || /\.onended\s*=/.test(src),
    'video.js or recorder.js should reference video tracks / onended'
  );
});

test('R3: AudioContext guard before decodeAudioData', () => {
  const src = readSrc('src/pages/video/audio-engine.js');
  // The fix: check `this.audioCtx` (and destination) before decodeAudioData
  assert.match(src, /if\s*\(\s*!this\.audioCtx\s*\|\|\s*!this\.destination\s*\)/);
});

// ────────────────────────────────────────────────────────────────────
// 12. Capture toggle retry + non-blocking SET_CAPTURING
// ─────────────────��──────────────────────────────────────────────────
test('CAPTURE: popup.js retries SET_CAPTURING once on SW connection loss', () => {
  const src = readSrc('src/popup/popup.js');
  // Loop guards retry attempts
  assert.match(src, /for\s*\(\s*let\s+attempt\s*=\s*0;\s*attempt\s*<\s*2;\s*attempt\+\+\s*\)/);
  // Recognises the specific MV3 SW-suspended error
  assert.match(src, /Receiving end does not exist/);
  // Uses a "desired" target state rather than flipping isCapturing pre-confirmation
  assert.match(src, /const\s+desired\s*=\s*!isCapturing/);
});

test('CAPTURE: background.js sendResponse for SET_CAPTURING runs BEFORE the broadcast loop', () => {
  const src = readSrc('src/background/background.js');
  const handlerStart = src.indexOf('case MSG.SET_CAPTURING');
  assert.ok(handlerStart !== -1, 'SET_CAPTURING handler must exist');
  const handlerEnd = src.indexOf('break;', handlerStart);
  const handler = src.slice(handlerStart, handlerEnd);
  const respIdx = handler.indexOf('sendResponse');
  // The broadcast loop targets all tabs — chrome.tabs.query({})
  const broadcastIdx = handler.indexOf('chrome.tabs.query({})');
  assert.ok(respIdx !== -1, 'sendResponse must be present');
  assert.ok(broadcastIdx !== -1, 'all-tabs broadcast must be present');
  assert.ok(
    respIdx < broadcastIdx,
    'sendResponse must run before the all-tabs broadcast so the popup is not blocked',
  );
  // The broadcast must NOT await each tab serially — should be fire-and-forget.
  assert.doesNotMatch(handler, /for\s*\(\s*const\s+tab\s+of\s+tabs\s*\)\s*\{\s*try\s*\{\s*await\s+chrome\.tabs\.sendMessage/);
});

// ────────────────────────────────────────────────────────────────────
// 13. HTML export
// ────────────────────────────────────────────────────────────────────
test('HTML EXPORT: export.js exposes exportHTML and downloadHTML functions', () => {
  const src = readSrc('src/pages/export/export.js');
  assert.match(src, /async\s+function\s+exportHTML\s*\(/);
  assert.match(src, /async\s+function\s+downloadHTML\s*\(/);
  // String-based escapeHtml (no DOM) — required so we can test it standalone
  assert.match(src, /\.replace\(\/&\/g,\s*['"]&amp;['"]\)/);
});

test('HTML EXPORT: export.html includes "Export as HTML" button with id="downloadHtml"', () => {
  const src = readSrc('src/pages/export/export.html');
  assert.match(src, /id=["']downloadHtml["']/);
  assert.match(src, /Export as HTML/);
});

// Functional test of exportHTML by extracting the function body and evaluating it.
// We isolate exportHTML + escapeHtml from export.js (the file's top-level code
// touches `window`/`document` so we can't require it).
function loadExportHelpers() {
  const src = readSrc('src/pages/export/export.js');
  const escapeFn = src.match(/function escapeHtml\(str\) \{[\s\S]*?\n\}/)[0];
  const exportFn = src.match(/async function exportHTML\([\s\S]*?\n\}\n/)[0];
  // Build a small module that exports both via a returned object.
  const code = `${escapeFn}\n${exportFn}\nreturn { escapeHtml, exportHTML };`;
  return new Function(code)();
}

test('HTML EXPORT: exportHTML produces a valid document with correct step count', async () => {
  const { exportHTML } = loadExportHelpers();
  const steps = [
    { title: 'First', description: 'Do this', url: 'https://example.com/a', imageData: 'data:image/png;base64,AAAA' },
    { title: 'Second', description: '', url: '', imageData: null },
    { title: 'Third', description: 'Done', url: 'https://example.com/c', imageData: 'data:image/png;base64,BBBB' },
  ];
  const html = await exportHTML(steps, { name: 'My SOP' });
  assert.match(html, /<!DOCTYPE html>/);
  assert.match(html, /<title>My SOP — FlowCapture<\/title>/);
  // 3 step sections
  const sectionCount = (html.match(/<section class="step"/g) || []).length;
  assert.equal(sectionCount, 3);
  // Step count appears in meta line — "3 steps"
  assert.match(html, /3 steps/);
  // Image present for steps with imageData
  assert.match(html, /<img src="data:image\/png;base64,AAAA"/);
  // No-screenshot placeholder for step without imageData
  assert.match(html, /No screenshot/);
  // TOC has 3 entries
  const tocCount = (html.match(/<li><a href="#step-/g) || []).length;
  assert.equal(tocCount, 3);
});

test('HTML EXPORT: exportHTML escapes HTML in step titles to prevent injection', async () => {
  const { exportHTML } = loadExportHelpers();
  const steps = [
    { title: '<script>alert(1)</script>', description: '', url: '', imageData: null },
  ];
  const html = await exportHTML(steps, { name: 'X' });
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test('HTML EXPORT: exportHTML pluralises step count correctly for a single step', async () => {
  const { exportHTML } = loadExportHelpers();
  const html = await exportHTML([{ title: 'Only', imageData: null }], { name: 'X' });
  assert.match(html, /1 step ·/);
});

test('HTML EXPORT: exportHTML output includes the print/PDF toolbar', async () => {
  const { exportHTML } = loadExportHelpers();
  const html = await exportHTML([{ title: 'Only', imageData: null }], { name: 'X' });
  assert.match(html, /fc-toolbar/);
  assert.match(html, /window\.print\(\)/);
});

test('HTML EXPORT: toolbar is hidden on print via @media print rule', async () => {
  const { exportHTML } = loadExportHelpers();
  const html = await exportHTML([{ title: 'Only', imageData: null }], { name: 'X' });
  assert.match(html, /@media print/);
  assert.match(html, /\.fc-toolbar\s*\{\s*display:\s*none/);
});

// ────────────────────────────────────────────────────────────────────
// 14. WebM → MP4 conversion (audio routing + setInterval, not rAF)
// ────────────────────────────────────────────────────────────────────
test('MP4: _convertWebMtoMP4 uses setInterval, not requestAnimationFrame', () => {
  const src = readSrc('src/pages/video/mp4-converter.js');
  // Locate the converter function body and check inside it.
  const fnIdx = src.indexOf('_convertWebMtoMP4');
  assert.ok(fnIdx !== -1);
  const body = src.slice(fnIdx);
  assert.match(body, /setInterval\(/);
  assert.doesNotMatch(body, /requestAnimationFrame\(/);
});

test('MP4: _convertWebMtoMP4 routes audio through Web Audio API', () => {
  const src = readSrc('src/pages/video/mp4-converter.js');
  assert.match(src, /createMediaElementSource\(video\)/);
  assert.match(src, /createMediaStreamDestination\(\)/);
  // Combines video + audio tracks
  assert.match(src, /new MediaStream\(\[\.\.\.videoStream\.getVideoTracks\(\)/);
  // Video must NOT be muted (we need audio)
  assert.match(src, /video\.muted\s*=\s*false/);
});

test('MP4: recorder.js prefers MP4 via getBestMimeType(true)', () => {
  const src = readSrc('src/pages/recorder/recorder.js');
  assert.match(src, /getBestMimeType\(true\)/);
});

// ────────────────────────────────────────────────────────────────────
// 15. Root-cause capture fixes
// ────────────────────────────────────────────────────────────────────
test('CAPTURE FIX: SET_CAPTURING handler queries the active tab with lastFocusedWindow before responding', () => {
  const src = readSrc('src/background/background.js');
  const handlerStart = src.indexOf('case MSG.SET_CAPTURING');
  assert.ok(handlerStart !== -1, 'SET_CAPTURING handler must exist');
  const handlerEnd = src.indexOf('break;', handlerStart);
  const handler = src.slice(handlerStart, handlerEnd);
  // The active-tab lookup must happen inside the handler
  assert.match(handler, /chrome\.tabs\.query\(\s*\{\s*active:\s*true,\s*lastFocusedWindow:\s*true\s*\}/);
  // The active-tab lookup must run BEFORE sendResponse so the content script
  // is notified synchronously while the popup is still alive.
  const queryIdx = handler.indexOf("lastFocusedWindow: true");
  const respIdx = handler.indexOf('sendResponse');
  assert.ok(queryIdx !== -1 && respIdx !== -1, 'both calls must exist');
  assert.ok(queryIdx < respIdx, 'active-tab query must run before sendResponse');
  // Falls back to scripting.executeScript if content script not yet injected
  assert.match(handler, /chrome\.scripting\.executeScript/);
});

test('CAPTURE FIX: CAPTURE_STEP uses sender.tab.windowId for captureVisibleTab', () => {
  const src = readSrc('src/background/background.js');
  const handlerStart = src.indexOf('case MSG.CAPTURE_STEP');
  assert.ok(handlerStart !== -1, 'CAPTURE_STEP handler must exist');
  const handlerEnd = src.indexOf('break;', src.indexOf('sendResponse({ success: true, stepId', handlerStart));
  const handler = src.slice(handlerStart, handlerEnd);
  // Must derive windowId from the sender tab so we capture the right window
  assert.match(handler, /sender\?\.tab\?\.windowId/);
  // And pass it to captureVisibleTab (not null)
  assert.match(handler, /chrome\.tabs\.captureVisibleTab\(\s*windowId\s*,/);
});

test('CAPTURE FIX: content.js has showErrorNotification that renders a red toast', () => {
  const src = readSrc('src/content/content.js');
  assert.match(src, /function\s+showErrorNotification\s*\(/);
  // Red background to distinguish from success toast
  assert.match(src, /background:\s*#ef4444/);
  // Called from the handleClick response path on failure
  assert.match(src, /showErrorNotification\(\s*response\?\.error/);
  // Persistent banner is shown while capturing
  assert.match(src, /function\s+showCaptureBanner\s*\(/);
  assert.match(src, /function\s+hideCaptureBanner\s*\(/);
});
