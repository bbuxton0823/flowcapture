# FlowCapture

> Chrome (Manifest V3) extension for capturing, annotating, and publishing Standard Operating Procedures. Built for the Housing Authority of the County of San Mateo (HACSM), usable anywhere.

FlowCapture turns a series of clicks in a browser into a captioned video and a polished PDF SOP. Final videos can include ElevenLabs narration, with optional Google Drive sync and direct publishing to YouTube or Vimeo for embedding into Yardi Aspire or another LMS.

## What it does

- **Auto-capture screenshots** every time you click in any tab, with element context, URL, and timestamp.
- **Editor** for reordering, annotating (highlight, arrow, blur, pixelate, redact, text), adding agency notes (info / warning / critical / tip), tagging by role, and local workflow status (Draft → In Review → Ready to publish).
- **One-click "Auto Draft"**, turns captured steps into a captioned 1080p video with intro / outro and chapter markers. Add ElevenLabs for embedded narration; browser voice is a speaker preview and is not reliable in the exported file.
- **PDF export** with cover page, table of contents, role badges, agency notes, and workflow status.
- **Screen recorder** with optional microphone, system audio, and scheduled TTS narration cues.
- **Direct publish** to YouTube (unlisted by default) or Vimeo, with embed URL + iframe ready for paste.
- **Google Drive team sync** (optional, opt-in).
- **Local-first storage**, screenshots in IndexedDB, settings in `chrome.storage.local`, no remote backend.

## Architecture at a glance

```
manifest.json (MV3)
├─ background/background.js       Service worker · capture, IndexedDB, message hub
├─ content/content.js             Injected click listener · sends CAPTURE_STEP messages
├─ popup/                         Toolbar popup · start/stop, navigation, Drive sync UI
├─ pages/
│  ├─ editor/                     Step review, drag-reorder, annotation, role/notes
│  ├─ recorder/                   Screen recording (MediaRecorder + WebRTC)
│  ├─ video/                      Canvas video generator · audio-engine.js · mp4-converter.js
│  ├─ export/                     jsPDF-based PDF generator
│  ├─ settings/                   API key management (ElevenLabs, YouTube, Vimeo)
│  └─ onboarding/                 First-run wizard
└─ shared/
   ├─ logger.js                   Tiny scoped logger
   ├─ settings-store.js           Unified credential storage
   ├─ sop-transfer.js             .flowcapture file import/export
   ├─ drive-sync.js               Google Drive integration
   ├─ youtube-uploader.js         Resumable YouTube upload + OAuth flow
   └─ vimeo-uploader.js           Vimeo tus upload + PAT auth
```

Storage:
- **IndexedDB (`FlowCaptureDB`)**, `screenshots` and `recordings` object stores. Holds the heavy binary data.
- **chrome.storage.local**, project metadata, settings, capture state, Drive config. Never synced.

Messages between the service worker and pages/content scripts go through `chrome.runtime.sendMessage`. See `src/background/background.js` for the full message vocabulary (`CAPTURE_STEP`, `GET_STEPS`, `UPDATE_STEP`, etc.).

## Install (development)

```bash
git clone https://github.com/bbuxton0823/flowcapture.git
cd flowcapture

# Open Chrome → chrome://extensions → enable Developer Mode
# → "Load unpacked" → select this folder.
```

There is no build step, the extension is plain JavaScript, no bundler. `package.json` only declares optional ffmpeg.wasm dependencies; they aren't required for the shipped flow.

## Configuration

All credentials are **BYO (bring-your-own)**, nothing is baked into the extension. Each user (or each PCO at an agency) provides their own API keys via **Settings**.

See [`.env.example`](.env.example) for the full list of values you need to gather. The extension does not read `.env` directly (Chrome extensions can't); the file is documentation of what to paste into the **Settings** page after install.

### ElevenLabs (optional, for AI narration)
1. Get an API key at https://elevenlabs.io/app/settings/api-keys
2. Open FlowCapture → Settings → ElevenLabs → paste the key
3. Click "Load voices" → pick a default voice
4. Click "Test" to verify

### YouTube (optional, for publishing)
1. Create a Google Cloud project, enable **YouTube Data API v3**
2. Create OAuth 2.0 Client ID (type: Web application)
3. Add the redirect URI shown in Settings → YouTube → "Your redirect URI"
4. Paste **Client ID** and **Client Secret** into Settings
5. Click "Authorize YouTube" → approve in popup

### Vimeo (optional, for publishing)
1. Create an app at https://developer.vimeo.com/apps
2. Generate a Personal Access Token with scopes: `upload`, `edit`, `delete`, `video_files`, `public`, `private`
3. Paste into Settings → Vimeo

### Google Drive sync (optional)
This requires editing `manifest.json` because Chrome reads OAuth client IDs from the manifest at install time:

1. In the same Google Cloud project, create another **OAuth 2.0 Client ID** of type **Chrome Extension**, with the application ID matching your extension's ID from `chrome://extensions`.
2. Open `manifest.json` and add:
   ```json
   "oauth2": {
     "client_id": "YOUR_CLIENT_ID.apps.googleusercontent.com",
     "scopes": ["https://www.googleapis.com/auth/drive.file"]
   }
   ```
3. Reload the extension.

Without this section, Drive sync is disabled but the rest of the extension works fine. The codebase detects the placeholder and surfaces a setup error instead of an opaque OAuth failure.

## Privacy & data flow

- Captured screenshots and recordings **never leave the device** unless the user explicitly publishes (YouTube/Vimeo), exports (PDF/.flowcapture/ZIP), or enables Drive sync.
- API keys live in `chrome.storage.local`, which is per-machine and never cloud-synced.
- The Google Drive scope used (`drive.file`) only grants access to files the extension creates, it cannot read the user's other files.
- Annotation tools include **blur / pixelate / redact** for removing PII from screenshots before export.

## Known limitations

- **MP4 in Chrome**: native MP4 recording via `MediaRecorder` is available on supported Chrome/platform combinations. When unavailable, FlowCapture honestly falls back to WebM and shows conversion guidance.
- **Tab capture**: extension-driven tab capture only works when invoked from a user gesture in the extension's own UI; some Chrome policies disable it entirely.
- **YouTube quota**: the YouTube Data API has a default daily quota of 10,000 units. Each upload costs ~1,600 units, about six uploads/day per project. Increase the quota in Google Cloud if needed.

## Versions

- **1.6.4**, Capture reliability hardening, safer project clearing, role-filtered video fix, and active smoke tests
- **1.6.1**, Auto Video guard modal for missing ElevenLabs key
- **1.6.0**, One-click Auto Video button
- **1.5.0**, YouTube/Vimeo publishing, settings page, ElevenLabs integration
- **1.0.0**, Initial release: capture, edit, PDF export

See [`CHANGELOG.md`](CHANGELOG.md) for full history.

## License

MIT, see [`LICENSE`](LICENSE).
