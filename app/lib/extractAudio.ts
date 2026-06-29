// Client-side audio extraction. When a user uploads a video file, pull the
// audio track out and return it as a compact WAV (mono, 16kHz, 16-bit PCM)
// — the exact shape Whisper prefers + small enough to fit the 25MB upload
// cap on anything up to ~2 hours of speech.
//
// No external dependencies — we decode via the browser's native codec stack
// (Web Audio decodeAudioData), downmix + downsample in an OfflineAudioContext,
// and hand-roll the WAV header.

export type ExtractResult = {
  /** The extracted audio as a data URL ready for POST to upload-voiceover. */
  dataUrl: string;
  /** Uncompressed byte count — useful for the 25MB Whisper cap check. */
  bytes: number;
  /** Duration in seconds, for UI display. */
  durationSec: number;
  /** Was the source already audio (pass-through), or did we extract? */
  extracted: boolean;
};

const TARGET_SAMPLE_RATE = 16000; // Whisper resamples to 16kHz internally anyway

export async function extractAudioFromFile(file: File): Promise<ExtractResult> {
  // Audio-only files: read straight to a data URL, no re-encoding.
  if (file.type.startsWith('audio/')) {
    return {
      dataUrl: await readAsDataUrl(file),
      bytes: file.size,
      durationSec: 0, // unknown without decoding
      extracted: false,
    };
  }

  // Video (or unknown — we'll still try to decode with Web Audio).
  const arrayBuffer = await file.arrayBuffer();
  const AC = (window.AudioContext || (window as any).webkitAudioContext) as typeof AudioContext;
  if (!AC) throw new Error('Web Audio API unavailable in this browser');
  const ctx = new AC();
  let decoded: AudioBuffer;
  try {
    decoded = await new Promise<AudioBuffer>((resolve, reject) => {
      ctx.decodeAudioData(arrayBuffer.slice(0), resolve, reject);
    });
  } catch (e: any) {
    ctx.close();
    throw new Error(`Couldn't decode audio from this file type (${file.type || 'unknown'}). Try MP3, M4A, WAV, or a browser-decodable video (MP4/WebM/MOV).`);
  }
  ctx.close();

  // Downmix + downsample in an OfflineAudioContext. Mono 16kHz keeps Whisper
  // happy while keeping the output file small enough for the 25MB cap.
  const outFrames = Math.ceil(decoded.duration * TARGET_SAMPLE_RATE);
  const offline = new (window.OfflineAudioContext || (window as any).webkitOfflineAudioContext)(
    1,              // mono
    outFrames,
    TARGET_SAMPLE_RATE,
  );
  const src = offline.createBufferSource();
  src.buffer = decoded;
  src.connect(offline.destination);
  src.start(0);
  const rendered = await offline.startRendering();

  const wavBytes = audioBufferToWav(rendered);
  const blob = new Blob([wavBytes], { type: 'audio/wav' });
  const dataUrl = await readAsDataUrl(new File([blob], 'extracted.wav', { type: 'audio/wav' }));

  return {
    dataUrl,
    bytes: wavBytes.byteLength,
    durationSec: decoded.duration,
    extracted: true,
  };
}

function readAsDataUrl(file: File | Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result || ''));
    fr.onerror = reject;
    fr.readAsDataURL(file);
  });
}

// --- WAV encoder: mono 16-bit PCM @ whatever the AudioBuffer's sampleRate is ---

function audioBufferToWav(buffer: AudioBuffer): ArrayBuffer {
  const numChannels = 1; // we're always mono after the OfflineAudioContext downmix
  const sampleRate = buffer.sampleRate;
  const bitDepth = 16;
  const bytesPerSample = bitDepth / 8;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = buffer.length * blockAlign;
  const totalSize = 44 + dataSize;
  const out = new ArrayBuffer(totalSize);
  const view = new DataView(out);

  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, totalSize - 8, true);
  writeAscii(view, 8, 'WAVE');

  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);        // fmt chunk size
  view.setUint16(20, 1, true);         // PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitDepth, true);

  writeAscii(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  const ch = buffer.getChannelData(0);
  let offset = 44;
  for (let i = 0; i < ch.length; i++) {
    const s = Math.max(-1, Math.min(1, ch[i]));
    const int16 = s < 0 ? s * 0x8000 : s * 0x7fff;
    view.setInt16(offset, int16, true);
    offset += 2;
  }
  return out;
}

function writeAscii(view: DataView, offset: number, text: string) {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
}
