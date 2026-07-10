# Installing FlowCapture

FlowCapture is a Chrome extension — there's no App Store listing. Install takes ~60 seconds.

## Step 1 — Get the files

**Option A — Download ZIP (easiest)**
1. [Click here to download FlowCapture v1.6.4.zip](https://github.com/bbuxton0823/flowcapture/archive/refs/heads/main.zip) — latest stable one-click install
2. Unzip it anywhere on your computer

**Option B — Clone with Git**
```bash
git clone https://github.com/bbuxton0823/flowcapture.git
```

## Step 2 — Load into Chrome

1. Open Chrome and navigate to `chrome://extensions`
2. Enable **Developer mode** using the toggle in the top-right corner
3. Click **"Load unpacked"**
4. Select the `flowcapture` folder (the one containing `manifest.json`)
5. FlowCapture appears in your Chrome toolbar ✓

> **Tip:** Pin it by clicking the puzzle-piece Extensions icon → pin FlowCapture for easy access.

## Step 3 — First run

Click the FlowCapture icon → walk through the short onboarding wizard. You can start capturing immediately with no configuration.

## Optional integrations

| Feature | What you need | Where to configure |
|---|---|---|
| AI narration (ElevenLabs) | Free API key from [elevenlabs.io](https://elevenlabs.io/app/settings/api-keys) | Settings → ElevenLabs |
| Publish to YouTube | YouTube Data API v3 OAuth credentials | Settings → YouTube |
| Publish to Vimeo | Vimeo Personal Access Token | Settings → Vimeo |
| Google Drive sync | Chrome Extension OAuth client ID added to `manifest.json` | See **Google Drive sync** in `README.md` |

No integrations are required — everything works locally out of the box.

## Updating

Re-download the ZIP (or `git pull`) and reload the extension:
`chrome://extensions` → FlowCapture → click the ↺ refresh icon.

## Troubleshooting

**Extension doesn't appear after loading:**
Make sure you selected the folder containing `manifest.json` (not a parent or child folder).

**Capture doesn't work on a page:**
Some Chrome system pages (`chrome://`, `chrome-extension://`) block content scripts — this is a Chrome security restriction. The extension works on all normal `http://` and `https://` pages.

**ElevenLabs voices don't load:**
Verify your API key in Settings → ElevenLabs → click "Test". Check that your ElevenLabs plan has API access enabled.

---
[📄 View full documentation](README.md) · [🌐 Install guide (web)](https://bbuxton0823.github.io/flowcapture/) · [⭐ Star on GitHub](https://github.com/bbuxton0823/flowcapture)
