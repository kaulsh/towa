import { toFile } from "openai";

import { getLogger } from "../../logging.js";
import {
  isTelegramVoiceOgg,
  telegramVoiceToWav16kMono,
} from "./voice-to-wav.js";

function filenameForMime(mimeType: string): string {
  if (mimeType.includes("ogg") || mimeType.includes("opus")) return "voice.ogg";
  if (mimeType.includes("mpeg") || mimeType.includes("mp3")) return "audio.mp3";
  if (mimeType.includes("wav")) return "audio.wav";
  if (mimeType.includes("webm")) return "voice.webm";
  return "audio.bin";
}

/** Normalize OpenAI / Ollama transcription JSON (or plain string) to text. */
export function extractTranscriptionText(raw: unknown): string {
  if (typeof raw === "string") {
    return raw.trim();
  }
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    if (typeof obj.text === "string") {
      return obj.text.trim();
    }
    if (typeof obj.transcription === "string") {
      return obj.transcription.trim();
    }
    if (
      obj.message &&
      typeof obj.message === "object" &&
      typeof (obj.message as { content?: unknown }).content === "string"
    ) {
      return (obj.message as { content: string }).content.trim();
    }
  }
  return "";
}

/**
 * Transcribe audio via an OpenAI-compatible `/v1/audio/transcriptions` endpoint.
 *
 * Telegram voice notes are Ogg Opus; Gemma4-on-Ollama expects WAV-like audio,
 * so we decode Ogg→16 kHz mono WAV in-process (WASM, no host ffmpeg) before
 * upload. Sends `think=false` to avoid empty transcriptions from thinking mode.
 */
export async function transcribeOpenAICompatible(input: {
  baseURL: string;
  apiKey?: string;
  model: string;
  data: Buffer;
  mimeType: string;
}): Promise<string> {
  const log = getLogger("openai-transcribe");
  const baseURL = input.baseURL.replace(/\/+$/, "");

  let uploadData = input.data;
  let uploadMime = input.mimeType;
  let uploadName = filenameForMime(input.mimeType);

  if (isTelegramVoiceOgg(input.mimeType)) {
    log.info(
      { inBytes: input.data.length, mimeType: input.mimeType },
      "decoding Telegram voice note Ogg Opus → 16kHz mono WAV",
    );
    uploadData = await telegramVoiceToWav16kMono(input.data);
    uploadMime = "audio/wav";
    uploadName = "voice.wav";
    log.info({ outBytes: uploadData.length }, "voice note WAV ready");
  }

  const file = await toFile(uploadData, uploadName, { type: uploadMime });

  const form = new FormData();
  form.append("file", file);
  form.append("model", input.model);
  // Ignored by strict OpenAI; required for usable Gemma4 audio on Ollama.
  form.append("think", "false");

  log.info(
    {
      model: input.model,
      mimeType: uploadMime,
      bytes: uploadData.length,
      baseURL,
    },
    "POST /v1/audio/transcriptions",
  );

  const response = await fetch(`${baseURL}/audio/transcriptions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.apiKey ?? "ollama"}`,
    },
    body: form,
  });

  const bodyText = await response.text();
  let raw: unknown = bodyText;
  try {
    raw = JSON.parse(bodyText) as unknown;
  } catch {
    // plain-text body
  }

  if (!response.ok) {
    throw new Error(
      `transcriptions HTTP ${response.status}: ${bodyText.slice(0, 500)}`,
    );
  }

  const text = extractTranscriptionText(raw);
  if (!text) {
    log.warn({ raw }, "transcriptions returned empty text");
    throw new Error(
      "transcriptions returned empty text (check model audio support / think mode)",
    );
  }
  return text;
}
