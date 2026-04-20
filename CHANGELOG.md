# Changelog

All notable changes to FlowCapture will be documented in this file. Format loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow semver.

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
