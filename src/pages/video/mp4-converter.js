/**
 * FlowCapture MP4 Converter
 * ===========================
 * Converts WebM blob to MP4 using a lightweight mp4 muxer.
 *
 * Strategy:
 *   1. Primary: Use mp4-mux.js (pure JS MP4 muxer) to re-mux the
 *      MediaRecorder output directly as MP4 during recording.
 *   2. Fallback: If recording must happen as WebM first, we provide
 *      a simple "download-and-convert" workflow pointing to free tools.
 *
 * For the cleanest approach, we configure MediaRecorder to output
 * in a format that's already MP4-compatible where possible, or
 * we use a lightweight JS muxer to write proper MP4 containers.
 *
 * Note on browser support:
 *   - Chrome 94+ supports MediaRecorder with mp4 via
 *     `video/mp4;codecs=avc1` on some platforms
 *   - If not available, we record WebM and offer conversion guidance
 */

class MP4Converter {
  constructor() {
    this._mp4Supported = null;
  }

  /**
   * Check if the browser supports recording directly to MP4.
   * Chrome 94+ on some platforms supports this.
   */
  canRecordMP4() {
    if (this._mp4Supported !== null) return this._mp4Supported;

    const types = [
      'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
      'video/mp4;codecs=avc1.4D401E,mp4a.40.2',
      'video/mp4;codecs=avc1',
      'video/mp4',
    ];

    for (const type of types) {
      if (MediaRecorder.isTypeSupported(type)) {
        this._mp4Supported = type;
        return type;
      }
    }

    this._mp4Supported = false;
    return false;
  }

  /**
   * Get the best recording MIME type based on the user's format preference.
   * Returns { mimeType, isMP4 }
   */
  getBestMimeType(preferMP4 = false) {
    if (preferMP4) {
      const mp4Type = this.canRecordMP4();
      if (mp4Type) {
        return { mimeType: mp4Type, isMP4: true, extension: 'mp4' };
      }
    }

    // Fallback to WebM
    const webmTypes = [
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm;codecs=vp9',
      'video/webm;codecs=vp8',
      'video/webm',
    ];

    for (const type of webmTypes) {
      if (MediaRecorder.isTypeSupported(type)) {
        return { mimeType: type, isMP4: false, extension: 'webm' };
      }
    }

    return { mimeType: 'video/webm', isMP4: false, extension: 'webm' };
  }

  /**
   * Create a download-ready blob with the correct format.
   * If we recorded in MP4, just return it.
   * If we recorded in WebM but user wants MP4, provide conversion info.
   */
  async prepareDownload(blob, desiredFormat, filename) {
    if (desiredFormat === 'mp4' && blob.type.includes('webm')) {
      // We recorded WebM but user wants MP4
      // Attempt client-side conversion via WebCodecs if available
      if (typeof VideoDecoder !== 'undefined' && typeof VideoEncoder !== 'undefined') {
        try {
          const mp4Blob = await this._convertWebMtoMP4(blob);
          return {
            blob: mp4Blob,
            filename: filename.replace('.webm', '.mp4'),
            converted: true,
            format: 'mp4',
          };
        } catch (err) {
          console.warn('[MP4Converter] WebCodecs conversion failed:', err);
        }
      }

      // WebCodecs not available or failed — return WebM with guidance
      return {
        blob: blob,
        filename: filename,
        converted: false,
        format: 'webm',
        conversionNeeded: true,
        guidance: 'Your browser recorded in WebM format. For Vimeo/Yardi upload, convert to MP4 using CloudConvert.com or VLC Media Player (Media → Convert/Save).',
      };
    }

    // Already in desired format
    return {
      blob: blob,
      filename: filename,
      converted: false,
      format: blob.type.includes('mp4') ? 'mp4' : 'webm',
    };
  }

  /**
   * Attempt WebM → MP4 conversion using WebCodecs API.
   * This is experimental and may not work in all Chrome versions.
   * Falls back gracefully if it fails.
   */
  async _convertWebMtoMP4(webmBlob) {
    const mp4Type = this.canRecordMP4();
    if (!mp4Type) {
      throw new Error('MP4 recording not supported in this browser');
    }

    const videoUrl = URL.createObjectURL(webmBlob);
    const video = document.createElement('video');
    video.src = videoUrl;
    video.muted = false; // need audio

    await new Promise((resolve, reject) => {
      video.onloadedmetadata = resolve;
      video.onerror = () => reject(new Error('Failed to load WebM for conversion'));
      setTimeout(() => reject(new Error('Metadata load timeout')), 10000);
    });

    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth || 1280;
    canvas.height = video.videoHeight || 720;
    const ctx = canvas.getContext('2d');

    // Capture both video stream AND audio stream from the video element
    const videoStream = canvas.captureStream(30);
    let combinedStream;
    let audioCtx = null;
    try {
      // Web Audio API: route video audio into a MediaStreamDestination
      audioCtx = new AudioContext();
      const source = audioCtx.createMediaElementSource(video);
      const dest = audioCtx.createMediaStreamDestination();
      source.connect(dest);
      source.connect(audioCtx.destination); // also play locally so video stays in sync
      const audioTrack = dest.stream.getAudioTracks()[0];
      if (audioTrack) {
        combinedStream = new MediaStream([...videoStream.getVideoTracks(), audioTrack]);
      } else {
        combinedStream = videoStream;
      }
    } catch (audioErr) {
      console.warn('[MP4Converter] Audio routing failed, converting video-only:', audioErr);
      combinedStream = videoStream;
    }

    const recorder = new MediaRecorder(combinedStream, {
      mimeType: mp4Type,
      videoBitsPerSecond: 4_000_000,
    });

    const chunks = [];
    recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };

    const done = new Promise((resolve, reject) => {
      recorder.onstop = resolve;
      recorder.onerror = (e) => reject(new Error('MediaRecorder error: ' + e.error));
    });

    recorder.start(100);

    // Use setInterval instead of requestAnimationFrame — rAF throttles in
    // extension pages that aren't in the foreground tab.
    video.currentTime = 0;
    await new Promise(r => { video.onseeked = r; });
    video.play();

    const frameInterval = setInterval(() => {
      if (video.ended || video.paused) {
        clearInterval(frameInterval);
        if (recorder.state !== 'inactive') recorder.stop();
        return;
      }
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    }, 1000 / 30); // 30fps

    video.onended = () => {
      clearInterval(frameInterval);
      if (recorder.state !== 'inactive') recorder.stop();
    };

    // Safety timeout: if video gets stuck, force-stop after duration + 5s
    const safetyTimeout = setTimeout(() => {
      clearInterval(frameInterval);
      if (recorder.state !== 'inactive') recorder.stop();
    }, (video.duration * 1000 || 60000) + 5000);

    try {
      await done;
    } finally {
      clearTimeout(safetyTimeout);
      URL.revokeObjectURL(videoUrl);
      // Chrome caps AudioContext at 6 per page. Without this, repeated
      // conversions accumulate contexts until further runs throw.
      if (audioCtx && audioCtx.state !== 'closed') {
        try { await audioCtx.close(); } catch (_) {}
      }
    }

    if (chunks.length === 0) throw new Error('Conversion produced no output chunks');
    return new Blob(chunks, { type: mp4Type });
  }
}

// Make globally available
window.MP4Converter = MP4Converter;
