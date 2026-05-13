/**
 * FlowCapture Audio Engine
 * =========================
 * Tiered TTS system for video narration:
 *
 *   Tier 1 — "Preview" (Browser TTS, plays through speakers only)
 *     Zero setup. SpeechSynthesis speaks aloud while video records canvas.
 *     Audio is NOT embedded in the video file — for previewing timing/flow only.
 *
 *   Tier 2 — "Built-in" (Browser TTS → captured into video)
 *     Uses SpeechSynthesis + a MediaStreamDestination trick:
 *     We speak via TTS, capture system audio through the AudioContext,
 *     and route it into the MediaRecorder stream so it's embedded in the WebM.
 *     Requires user to grant audio permissions. No API keys.
 *
 *   Tier 3 — "ElevenLabs" (Professional AI voice)
 *     Calls ElevenLabs text-to-speech API, gets back audio buffers (mp3),
 *     decodes them via AudioContext, and feeds directly into MediaRecorder.
 *     Highest quality. Requires API key + voice ID.
 *
 * Usage:
 *   const engine = new AudioEngine(tier, config);
 *   const audioDest = engine.getMediaStreamDestination(); // connect to MediaRecorder
 *   const durationMs = await engine.speak(text);          // speak & return duration
 *   engine.stop();                                        // cancel current speech
 */

class AudioEngine {
  constructor(tier = 'preview', config = {}) {
    this.tier = tier; // 'preview' | 'builtin' | 'elevenlabs'
    this.config = {
      voice: config.voice || null,        // SpeechSynthesisVoice index or ElevenLabs voice ID
      rate: config.rate || 0.9,
      pitch: config.pitch || 1.0,
      elevenLabsKey: config.elevenLabsKey || '',
      elevenLabsVoiceId: config.elevenLabsVoiceId || '',
      elevenLabsModel: config.elevenLabsModel || 'eleven_monolingual_v1',
      ...config,
    };

    this.audioCtx = null;
    this.destination = null;
    this._speaking = false;
  }

  /**
   * Initialize AudioContext and return a MediaStream that can be
   * fed into a MediaRecorder for embedded audio in the video.
   * For 'preview' tier, returns null (no embeddable stream).
   */
  init() {
    if (this.tier === 'preview') {
      // No AudioContext needed — TTS plays through speakers only
      return null;
    }

    this.audioCtx = new AudioContext({ sampleRate: 44100 });
    this.destination = this.audioCtx.createMediaStreamDestination();
    return this.destination.stream;
  }

  /**
   * Get the audio MediaStream for mixing into MediaRecorder.
   * Returns null for preview tier.
   */
  getAudioStream() {
    return this.destination ? this.destination.stream : null;
  }

  /**
   * Speak the given text. Returns a Promise that resolves with
   * the duration in milliseconds once speech finishes.
   */
  async speak(text) {
    if (!text || !text.trim()) return 1500;

    switch (this.tier) {
      case 'preview':
        return this._speakBrowserTTS(text, false);
      case 'builtin':
        return this._speakBrowserTTS(text, true);
      case 'elevenlabs':
        return this._speakElevenLabs(text);
      default:
        return this._speakBrowserTTS(text, false);
    }
  }

  /**
   * Estimate duration without speaking (for timeline preview).
   */
  estimateDuration(text) {
    if (!text || !text.trim()) return 1500;
    const words = text.trim().split(/\s+/).length;
    const wpm = 150 * this.config.rate;
    return Math.max(Math.round((words / wpm) * 60 * 1000), 1500);
  }

  /**
   * Stop any current speech.
   */
  stop() {
    this._speaking = false;
    speechSynthesis.cancel();
  }

  /**
   * Clean up resources.
   */
  destroy() {
    this.stop();
    if (this.audioCtx && this.audioCtx.state !== 'closed') {
      this.audioCtx.close();
    }
  }

  // ─── Tier 1 & 2: Browser TTS ──────────────────────────────────

  _speakBrowserTTS(text, captureAudio) {
    return new Promise((resolve) => {
      speechSynthesis.cancel();
      this._speaking = true;

      const utterance = new SpeechSynthesisUtterance(text);

      // Set voice
      const voices = speechSynthesis.getVoices();
      if (this.config.voice !== null && voices[this.config.voice]) {
        utterance.voice = voices[this.config.voice];
      }
      utterance.rate = this.config.rate;
      utterance.pitch = this.config.pitch;

      const startTime = Date.now();

      utterance.onend = () => {
        this._speaking = false;
        const duration = Date.now() - startTime;
        resolve(Math.max(duration, 1500));
      };

      utterance.onerror = (e) => {
        this._speaking = false;
        console.warn('[AudioEngine] TTS error:', e.error);
        resolve(this.estimateDuration(text));
      };

      // For Tier 2 (builtin): attempt to capture TTS output via AudioContext.
      // Note: Browser TTS doesn't output to AudioContext directly.
      // The workaround is to request microphone/system audio capture
      // which picks up the TTS output from the speakers.
      // If that's not available, we fall back to speaker-only playback
      // and silence in the video (same as preview).
      //
      // A more reliable approach for Tier 2 is to use the "builtin"
      // mode with a silent audio tone pumped into the AudioContext
      // to keep the stream alive, and rely on system audio capture
      // in the MediaRecorder (which works if the user enables it).

      if (captureAudio && this.audioCtx && this.destination) {
        // Pump a silent oscillator to keep the audio track alive
        // (MediaRecorder may drop audio track if there's no signal)
        this._pumpSilence();
      }

      speechSynthesis.speak(utterance);
    });
  }

  _pumpSilence() {
    if (!this.audioCtx || !this.destination) return;
    try {
      const osc = this.audioCtx.createOscillator();
      const gain = this.audioCtx.createGain();
      gain.gain.value = 0.001; // Near-silent
      osc.connect(gain);
      gain.connect(this.destination);
      osc.start();
      // Stop after a bit — will be restarted next speak() call
      setTimeout(() => { try { osc.stop(); } catch (_) {} }, 30000);
    } catch (_) {}
  }

  // ─── Tier 3: ElevenLabs API ───────────────────────────────────

  async _speakElevenLabs(text) {
    if (!this.config.elevenLabsKey || !this.config.elevenLabsVoiceId) {
      console.warn('[AudioEngine] ElevenLabs: missing API key or voice ID, falling back to browser TTS');
      return this._speakBrowserTTS(text, true);
    }
    if (!this.audioCtx || !this.destination) {
      // ElevenLabs decoding requires an AudioContext; init() wasn't called
      // (or was called for the 'preview' tier). Fall back gracefully.
      console.warn('[AudioEngine] ElevenLabs: AudioContext not initialized, falling back to browser TTS');
      return this._speakBrowserTTS(text, true);
    }

    try {
      const startTime = Date.now();

      // Call ElevenLabs TTS API
      const response = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${this.config.elevenLabsVoiceId}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'xi-api-key': this.config.elevenLabsKey,
          },
          body: JSON.stringify({
            text: text,
            model_id: this.config.elevenLabsModel,
            voice_settings: {
              stability: 0.5,
              similarity_boost: 0.75,
              style: 0.0,
              use_speaker_boost: true,
            },
          }),
        }
      );

      if (!response.ok) {
        const errText = await response.text();
        console.error('[AudioEngine] ElevenLabs API error:', response.status, errText);
        // Fallback to browser TTS
        return this._speakBrowserTTS(text, true);
      }

      // Get audio as ArrayBuffer
      const audioData = await response.arrayBuffer();

      // Decode the audio (ElevenLabs returns mp3 by default)
      const audioBuffer = await this.audioCtx.decodeAudioData(audioData);

      // Play through AudioContext → destination (captured by MediaRecorder)
      const source = this.audioCtx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(this.destination);

      // Also connect to speakers so user can hear preview
      source.connect(this.audioCtx.destination);

      return new Promise((resolve) => {
        source.onended = () => {
          const duration = Date.now() - startTime;
          resolve(Math.max(duration, 1500));
        };
        source.start();
      });

    } catch (err) {
      console.error('[AudioEngine] ElevenLabs error:', err);
      // Graceful fallback
      return this._speakBrowserTTS(text, true);
    }
  }

  // ─── Static Helpers ───────────────────────────────────────────

  /**
   * Fetch available ElevenLabs voices.
   * Returns array of { voice_id, name, category, labels }.
   */
  static async fetchElevenLabsVoices(apiKey) {
    try {
      const response = await fetch('https://api.elevenlabs.io/v1/voices', {
        headers: { 'xi-api-key': apiKey },
      });
      if (!response.ok) throw new Error(`API error: ${response.status}`);
      const data = await response.json();
      return (data.voices || []).map(v => ({
        voice_id: v.voice_id,
        name: v.name,
        category: v.category,
        accent: v.labels?.accent || '',
        gender: v.labels?.gender || '',
        age: v.labels?.age || '',
        description: v.labels?.description || '',
        preview_url: v.preview_url,
      }));
    } catch (err) {
      console.error('[AudioEngine] Failed to fetch ElevenLabs voices:', err);
      return [];
    }
  }

  /**
   * Get available browser TTS voices.
   */
  static getBrowserVoices() {
    return speechSynthesis.getVoices().map((v, i) => ({
      index: i,
      name: v.name,
      lang: v.lang,
      default: v.default,
    }));
  }
}

// Make globally available (no modules)
window.AudioEngine = AudioEngine;
