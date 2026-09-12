import { OggOpusDecoder } from "ogg-opus-decoder";

/** Practical Gemma4/Ollama audio window (~30s at 16 kHz). */
export const VOICE_TRANSCRIBE_MAX_SECONDS = 30;

/**
 * Encode mono PCM float samples as a 16-bit little-endian WAV buffer.
 */
export function encodeMonoPcm16Wav(samples: Float32Array, sampleRate: number): Buffer {
  const dataSize = samples.length * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16); // PCM chunk size
  buffer.writeUInt16LE(1, 20); // PCM format
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buffer.writeUInt16LE(2, 32); // block align
  buffer.writeUInt16LE(16, 34); // bits per sample
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);

  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]!));
    buffer.writeInt16LE((s * 0x7fff) | 0, offset);
    offset += 2;
  }
  return buffer;
}

function mixToMono(channelData: Float32Array[]): Float32Array {
  if (channelData.length === 0) {
    return new Float32Array(0);
  }
  if (channelData.length === 1) {
    return channelData[0]!;
  }
  const len = channelData[0]!.length;
  const out = new Float32Array(len);
  const n = channelData.length;
  for (let i = 0; i < len; i++) {
    let sum = 0;
    for (let c = 0; c < n; c++) {
      sum += channelData[c]![i] ?? 0;
    }
    out[i] = sum / n;
  }
  return out;
}

/** Linear resample mono float PCM to a target rate. */
export function resampleMono(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate || input.length === 0) {
    return input;
  }
  const outLen = Math.max(1, Math.round((input.length * toRate) / fromRate));
  const out = new Float32Array(outLen);
  const ratio = fromRate / toRate;
  for (let i = 0; i < outLen; i++) {
    const src = i * ratio;
    const i0 = Math.floor(src);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const t = src - i0;
    out[i] = input[i0]! * (1 - t) + input[i1]! * t;
  }
  return out;
}

/**
 * Convert Telegram voice-note bytes (Ogg Opus) to 16 kHz mono WAV in-process.
 * No host ffmpeg — uses WASM `ogg-opus-decoder`. Truncates to
 * {@link VOICE_TRANSCRIBE_MAX_SECONDS}.
 */
export async function telegramVoiceToWav16kMono(input: Buffer): Promise<Buffer> {
  const decoder = new OggOpusDecoder();
  try {
    await decoder.ready;
    const decoded = await decoder.decodeFile(new Uint8Array(input));
    if (decoded.errors?.length) {
      const first = decoded.errors[0]!;
      throw new Error(`ogg-opus decode error: ${first.message ?? JSON.stringify(first)}`);
    }
    let mono = mixToMono(decoded.channelData);
    const fromRate = decoded.sampleRate || 48000;
    mono = resampleMono(mono, fromRate, 16000);
    const maxSamples = VOICE_TRANSCRIBE_MAX_SECONDS * 16000;
    if (mono.length > maxSamples) {
      mono = mono.subarray(0, maxSamples);
    }
    if (mono.length === 0) {
      throw new Error("ogg-opus decode produced no samples");
    }
    return encodeMonoPcm16Wav(mono, 16000);
  } finally {
    decoder.free();
  }
}

/** True when Telegram voice-note mime should be decoded from Ogg Opus. */
export function isTelegramVoiceOgg(mimeType: string): boolean {
  const m = mimeType.toLowerCase();
  return m.includes("ogg") || m.includes("opus");
}
