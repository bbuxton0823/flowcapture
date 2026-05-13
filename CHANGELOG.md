# Changelog

All notable changes to FlowCapture will be documented in this file. Format loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow semver.

## [1.6.4] - 2026-05-13

### Changed
- Bumped extension, package, popup, and one-click install copy to latest stable `v1.6.4`.
- `npm test` now runs the smoke suite with `node --test tests/*.test.js` instead of returning a placeholder success.

### Fixed
- Capture requests now send immediately from the content script so link/button clicks that navigate away do not lose the step before the delayed timer fires.
- Background project writes are serialized to prevent rapid captures or parallel editor/import actions from overwriting each other in `chrome.storage.local`.
- Clearing the current SOP now deletes only that project's screenshot records and no longer wipes unrelated projects' screenshots or saved recordings.
- Role-filtered video generation now renders the selected audience's actual steps instead of mixing filtered indices with the unfiltered step array.
- Editor step links now sanitize imported URLs to `http:`/`https:` and add `rel="noopener noreferrer"`.
- Captured form metadata no longer stores typed text-field values by default, reducing accidental PII in exports and Drive sync.

## [1.6.2] - 2026-05-13

### Added
- `README.md` (project purpose, architecture map, install + config).
- `.env.example` documenting every credential value the Settings page expects.
- `LICENSE` (MIT).
- `src/shared/logger.js` — tiny scoped logger so pages stop calling `console.*` directly.
- Step-count guard: capture rejects new steps past `MAX_STEPS_PER_PROJECT` (500) instead of silently corrupting `chrome.storage.local`.
- Hard-cap on `.flowcapture` imports (250 MB / 1000 steps) to refuse pathological files before parsing locks the tab.
- `chrome.runtime.onSuspend` handler closes the IndexedDB connection cleanly.
- Graceful shutdown on recorder and video pages — stops media streams + AudioContext on tab unload.

### Changed
- `package.json` — real metadata (name/version/license/keywords); `"test"` now exits 0 instead of 1.
- Unified ElevenLabs credential storage. `video.js` previously wrote to a separate `flowcapture_elevenlabs` key while the Settings page wrote to `flowcapture_settings.elevenLabs`; both now use the latter, with a one-time migration from the legacy key.
- Drive sync: token revocation switched from GET-with-token-in-URL to POST (token no longer in browser history / referer headers); Drive file IDs are URL-encoded; the folder-name `q=` query escapes single quotes / backslashes.
- Drive sync surfaces a clear "client ID not configured" error instead of Chrome's generic OAuth message when the manifest still has the placeholder client ID.
- `parseInt` calls across recorder, editor, and video now pass an explicit radix.

### Fixed
- **XSS in popup Drive file picker** — Drive-supplied file names and `modifiedBy.displayName` were interpolated into `innerHTML`. Other Google accounts in a shared folder could inject markup. Replaced with safe `textContent` DOM construction.
- **YouTube token expiry NaN** — if `expires_in` is missing from the OAuth response, `tokenExpiresAt` was set to `NaN`, immediately invalidating the token. Now coerced to a non-negative number.
- **Token-exchange validation** — `youtube-uploader` now throws on missing `access_token` in OAuth responses instead of silently storing `undefined`.
- **Upload validation** — youtube/vimeo `uploadVideo` rejects empty or non-Blob inputs, and restricts privacy values to the allowed set.
- **Audio-engine fallback** — `_speakElevenLabs` now falls back gracefully when `AudioContext` was not initialised (preview tier) instead of throwing on `decodeAudioData`.
- **Recorder cue deletion** — `narrationCues.sort()` previously returned the sorted array but the splice ran against the original; indices were off after the first sort. Sort in place so render indices match array indices.
- **Recorder stream cleanup** — `recordingStream.getVideoTracks()[0].onended = ...` threw when there was no video track. Now guarded.
- **Editor URL parsing** — `new URL(step.url)` threw for malformed URLs (e.g. captured from `javascript:` schemes), crashing the editor render. Wrapped in try/catch with a safe fallback.
- **Video page "guidance" alert** — was shown every time the user clicked Download MP4. Now shown once per generation.
- **Video page resource leak** — canvas and audio stream tracks are now stopped after generation completes.
- **Background capture** — rejects requests without a valid `sender.tab.id` so we don't try to screenshot the wrong context.

### Security
- `drive.file` scope review confirmed correct (least-privilege).
- Removed pattern of building Drive `q=` queries with raw string interpolation.

### Migration notes
- Users with an ElevenLabs key stored in the legacy `flowcapture_elevenlabs` location will have it migrated on first load of the video page; the legacy key is then removed.
- No permission changes. No project schema changes.

## [1.6.1] - 2026-04-20

### Added
- **Auto Video guard modal** (`src/pages/video/`) — when the user clicks the popup's "Auto Video" button and no ElevenLabs API key is saved, the video page now shows a confirmation dialog with three actions: *Configure ElevenLabs* (opens Settings), *Proceed with browser voice*, or *Cancel*. Replaces the previous silent fallback.
- "Don't ask again on this device" checkbox, persisted as `flowcapture_av_silent_ack` in `chrome.storage.local`. Applies only to Proceed and Configure; Cancel never persists (Cancel means "not now," not "never").
- Accessibility: modal uses `role="dialog"`, `aria-modal="true"`, `aria-labelledby`/`aria-describedby`; closes on Escape and on backdrop click (but not on inner card click); focus moves to the Configure button on open; respects `prefers-reduced-motion`.

### Changed
- `src/pages/video/video.js` — `maybeAutoStart()` now checks for an ElevenLabs key first; if none and the silent-ack flag is not set, it awaits `showAvModal()` before deciding whether to run. Factored ElevenLabs form-population into a new `applyElevenLabsToForm()` helper.
- Version: `manifest.json` 1.6.0 → 1.6.1, popup version label `v1.6` → `v1.6.1`.

### Fixed
- Silent ElevenLabs fallback in v1.6 — users who expected AI narration no longer get a browser voice without being warned.

### Verification
- JSDOM harness: 11/11 logic tests pass (markup, flag persistence, all decision branches, Escape, backdrop, inner-card-does-not-cancel, "don't ask again" rules).
- DOM ID parity: all 5 new IDs (`avModal`, `avDontAsk`, `avConfigureBtn`, `avProceedBtn`, `avCancelBtn`) match 1-to-1 between HTML and JS.
- Chrome runtime tests (load-unpacked): see `DIFF_SUMMARY.md` for the 7 acceptance scenarios.

### Migration notes
- No permission changes. No storage schema migration needed.
- To reset the "don't ask again" flag during testing: `chrome.storage.local.remove('flowcapture_av_silent_ack')` in the video page's DevTools console.

## [1.6.0] - prior

### Added
- One-click **Auto Video** button in the popup — opens `video.html?auto=1` which applies sensible defaults (1080p, gradient bg, fade transition, 1s pause, MP4, intro+outro on) and starts generation automatically.
- `package.json` with ffmpeg.wasm deps declared.

## [1.5.0] - prior

- Baseline: SOP capture, annotation, manual video generation, YouTube/Vimeo publish, Drive sync.
