/**
 * FlowCapture Settings Page Controller (v1.5)
 */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const Settings = window.FlowCaptureSettings;
  const YT = window.FlowCaptureYouTube;
  const VM = window.FlowCaptureVimeo;

  // ─── Init ─────────────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', async () => {
    await loadSettings();
    setupEventListeners();
    refreshAllStatuses();

    // Show the YT redirect URI for user to copy into Google Cloud
    if ($('ytRedirectUri')) {
      $('ytRedirectUri').textContent = YT.getRedirectUri();
    }
  });

  // ─── Load saved settings into form ────────────────────────────
  async function loadSettings() {
    const s = await Settings.getAll();

    $('elApiKey').value = s.elevenLabs.apiKey || '';
    $('elDefaultModel').value = s.elevenLabs.defaultModel || 'eleven_multilingual_v2';
    if (s.elevenLabs.defaultVoiceId) {
      // Try to populate the voice dropdown if key present
      if (s.elevenLabs.apiKey) {
        loadElevenLabsVoices(s.elevenLabs.apiKey, s.elevenLabs.defaultVoiceId);
      } else {
        addOption($('elDefaultVoice'), s.elevenLabs.defaultVoiceId, 'Saved voice (load to pick)');
        $('elDefaultVoice').value = s.elevenLabs.defaultVoiceId;
      }
    }

    $('ytClientId').value = s.youtube.clientId || '';
    $('ytClientSecret').value = s.youtube.clientSecret || '';

    $('vmToken').value = s.vimeo.accessToken || '';

    $('defaultPrivacy').value = s.defaults.privacy || 'unlisted';
  }

  // ─── Status pills ─────────────────────────────────────────────
  async function refreshAllStatuses() {
    setStatus('elStatus', (await Settings.hasElevenLabs()) ? 'connected' : 'idle',
      (await Settings.hasElevenLabs()) ? 'Configured' : 'Not configured');
    setStatus('ytStatus', (await Settings.hasYouTube()) ? 'connected' : 'idle',
      (await Settings.hasYouTube()) ? 'Authorized' : 'Not authorized');
    setStatus('vmStatus', (await Settings.hasVimeo()) ? 'connected' : 'idle',
      (await Settings.hasVimeo()) ? 'Configured' : 'Not configured');
  }

  function setStatus(id, state, text) {
    const el = $(id);
    el.className = 'status-pill';
    if (state === 'connected') el.classList.add('connected');
    if (state === 'error') el.classList.add('error');
    el.textContent = text;
  }

  // ─── Event wiring ─────────────────────────────────────────────
  function setupEventListeners() {
    // Reveal/hide password fields
    document.querySelectorAll('.reveal-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const target = $(btn.dataset.target);
        if (!target) return;
        target.type = target.type === 'password' ? 'text' : 'password';
      });
    });

    // Copy buttons
    document.querySelectorAll('.copy-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const targetText = $(btn.dataset.copy)?.textContent || '';
        navigator.clipboard.writeText(targetText).then(() => {
          btn.textContent = 'Copied!';
          setTimeout(() => (btn.textContent = 'Copy'), 1500);
        });
      });
    });

    // Back / Done
    $('backBtn').addEventListener('click', () => window.close());

    // ElevenLabs
    $('elApiKey').addEventListener('change', saveElevenLabs);
    $('elDefaultModel').addEventListener('change', saveElevenLabs);
    $('elDefaultVoice').addEventListener('change', saveElevenLabs);
    $('elLoadVoicesBtn').addEventListener('click', async () => {
      await saveElevenLabs();
      const key = $('elApiKey').value.trim();
      if (!key) return toast('Enter your API key first', 'error');
      loadElevenLabsVoices(key);
    });
    $('elTestBtn').addEventListener('click', testElevenLabs);
    $('elClearBtn').addEventListener('click', async () => {
      if (!confirm('Clear all ElevenLabs settings?')) return;
      await Settings.clearSection('elevenLabs');
      $('elApiKey').value = '';
      $('elDefaultVoice').innerHTML = '<option value="">Load voices to pick one...</option>';
      refreshAllStatuses();
      toast('ElevenLabs settings cleared');
    });

    // YouTube
    $('ytClientId').addEventListener('change', saveYouTube);
    $('ytClientSecret').addEventListener('change', saveYouTube);
    $('ytAuthBtn').addEventListener('click', authorizeYouTube);
    $('ytTestBtn').addEventListener('click', testYouTube);
    $('ytClearBtn').addEventListener('click', async () => {
      if (!confirm('Disconnect YouTube and clear stored tokens?')) return;
      await Settings.clearSection('youtube');
      $('ytClientId').value = '';
      $('ytClientSecret').value = '';
      $('ytAuthStatus').className = 'status-msg';
      $('ytAuthStatus').textContent = '';
      refreshAllStatuses();
      toast('YouTube disconnected');
    });

    // Vimeo
    $('vmToken').addEventListener('change', saveVimeo);
    $('vmTestBtn').addEventListener('click', testVimeo);
    $('vmClearBtn').addEventListener('click', async () => {
      if (!confirm('Clear Vimeo settings?')) return;
      await Settings.clearSection('vimeo');
      $('vmToken').value = '';
      refreshAllStatuses();
      toast('Vimeo settings cleared');
    });

    // Defaults
    $('defaultPrivacy').addEventListener('change', async () => {
      await Settings.updateSection('defaults', { privacy: $('defaultPrivacy').value });
      toast('Saved');
    });

    // Wipe all
    $('wipeAllBtn').addEventListener('click', async () => {
      if (!confirm('Wipe ALL settings (ElevenLabs, YouTube, Vimeo)?\n\nThis cannot be undone.')) return;
      await Settings.clearAll();
      await loadSettings();
      refreshAllStatuses();
      toast('All settings wiped');
    });
  }

  // ─── ElevenLabs handlers ──────────────────────────────────────
  async function saveElevenLabs() {
    await Settings.updateSection('elevenLabs', {
      apiKey: $('elApiKey').value.trim(),
      defaultVoiceId: $('elDefaultVoice').value,
      defaultModel: $('elDefaultModel').value,
    });
    refreshAllStatuses();
  }

  async function loadElevenLabsVoices(apiKey, selectedId) {
    try {
      const res = await fetch('https://api.elevenlabs.io/v1/voices', {
        headers: { 'xi-api-key': apiKey },
      });
      if (!res.ok) throw new Error(`API error ${res.status}`);
      const data = await res.json();
      const voices = data.voices || [];
      const select = $('elDefaultVoice');
      select.innerHTML = '<option value="">— Pick a voice —</option>';
      voices.forEach((v) => {
        const desc = [v.labels?.gender, v.labels?.accent, v.labels?.description]
          .filter(Boolean).join(', ');
        addOption(select, v.voice_id, `${v.name}${desc ? ' (' + desc + ')' : ''}`);
      });
      if (selectedId) select.value = selectedId;
      toast(`Loaded ${voices.length} voices`, 'success');
    } catch (e) {
      toast(`Failed to load voices: ${e.message}`, 'error');
    }
  }

  async function testElevenLabs() {
    const key = $('elApiKey').value.trim();
    if (!key) return toast('Enter API key first', 'error');
    try {
      const res = await fetch('https://api.elevenlabs.io/v1/user', {
        headers: { 'xi-api-key': key },
      });
      if (!res.ok) {
        return toast(`Test failed: ${res.status} ${res.statusText}`, 'error');
      }
      const me = await res.json();
      const tier = me.subscription?.tier || 'free';
      const remaining = me.subscription?.character_limit
        ? `${me.subscription.character_limit - (me.subscription.character_count || 0)} characters remaining`
        : '';
      toast(`Connected! Tier: ${tier}. ${remaining}`, 'success');
      setStatus('elStatus', 'connected', `Connected (${tier})`);
    } catch (e) {
      toast(`Test failed: ${e.message}`, 'error');
    }
  }

  // ─── YouTube handlers ─────────────────────────────────────────
  async function saveYouTube() {
    await Settings.updateSection('youtube', {
      clientId: $('ytClientId').value.trim(),
      clientSecret: $('ytClientSecret').value.trim(),
    });
  }

  async function authorizeYouTube() {
    await saveYouTube();
    const clientId = $('ytClientId').value.trim();
    const clientSecret = $('ytClientSecret').value.trim();
    if (!clientId || !clientSecret) {
      return toast('Enter Client ID and Client Secret first', 'error');
    }
    setAuthStatus('Opening Google sign-in...', 'success');
    try {
      const code = await YT.authorize(clientId);
      setAuthStatus('Exchanging authorization code...', 'success');
      const tokens = await YT.exchangeCode(clientId, clientSecret, code);
      await Settings.updateSection('youtube', tokens);
      setAuthStatus('Authorized! YouTube ready to publish videos.', 'success');
      refreshAllStatuses();
      toast('YouTube authorized', 'success');
    } catch (e) {
      setAuthStatus(`Auth failed: ${e.message}`, 'error');
      toast(`YouTube auth failed: ${e.message}`, 'error');
    }
  }

  async function testYouTube() {
    setAuthStatus('Testing token...', 'success');
    const result = await YT.testConnection();
    if (result.ok) {
      setAuthStatus('Token valid — YouTube ready to publish.', 'success');
      toast('YouTube connection OK', 'success');
    } else {
      setAuthStatus(`Test failed: ${result.error}`, 'error');
      toast(`YouTube test failed: ${result.error}`, 'error');
    }
  }

  function setAuthStatus(msg, kind) {
    const el = $('ytAuthStatus');
    el.className = `status-msg ${kind}`;
    el.textContent = msg;
  }

  // ─── Vimeo handlers ───────────────────────────────────────────
  async function saveVimeo() {
    await Settings.updateSection('vimeo', {
      accessToken: $('vmToken').value.trim(),
    });
    refreshAllStatuses();
  }

  async function testVimeo() {
    await saveVimeo();
    const result = await VM.testConnection();
    if (result.ok) {
      toast(`Vimeo OK — ${result.user} (${result.account})`, 'success');
      setStatus('vmStatus', 'connected', `Connected (${result.account})`);
    } else {
      toast(`Vimeo test failed: ${result.error}`, 'error');
      setStatus('vmStatus', 'error', 'Test failed');
    }
  }

  // ─── Helpers ──────────────────────────────────────────────────
  function addOption(select, value, label) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = label;
    select.appendChild(opt);
  }

  function toast(msg, kind) {
    const el = $('toast');
    el.textContent = msg;
    el.className = 'toast show';
    if (kind) el.classList.add(kind);
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { el.className = 'toast'; }, 3500);
  }
})();
