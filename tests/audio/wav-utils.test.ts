import { describe, expect, it, vi } from 'vitest';
import { isWavBlob, normalizeASRUploadAudio } from '@/lib/audio/wav-utils';

describe('isWavBlob', () => {
  it('detects audio/wav MIME type', () => {
    const blob = new Blob([new Uint8Array(4)], { type: 'audio/wav' });
    expect(isWavBlob(blob)).toBe(true);
  });

  it('detects audio/x-wav MIME type', () => {
    const blob = new Blob([new Uint8Array(4)], { type: 'audio/x-wav' });
    expect(isWavBlob(blob)).toBe(true);
  });

  it('detects .wav file extension when MIME is missing', () => {
    const blob = new Blob([new Uint8Array(4)]);
    expect(isWavBlob(blob, 'recording.wav')).toBe(true);
    expect(isWavBlob(blob, 'recording.WAV')).toBe(true);
  });

  it('returns false for non-WAV blobs without a wav filename', () => {
    const blob = new Blob([new Uint8Array(4)], { type: 'audio/webm' });
    expect(isWavBlob(blob)).toBe(false);
    expect(isWavBlob(blob, 'recording.webm')).toBe(false);
  });
});

describe('normalizeASRUploadAudio', () => {
  it('passes through providers without WAV normalization unchanged', async () => {
    const input = new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/webm' });
    const result = await normalizeASRUploadAudio('openai-whisper', input);
    expect(result.blob).toBe(input);
    expect(result.fileName).toBe('recording.webm');
  });

  it('keeps WAV blobs unchanged for lemonade-asr', async () => {
    const input = new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/wav' });
    const result = await normalizeASRUploadAudio('lemonade-asr', input);
    expect(result.blob).toBe(input);
    expect(result.fileName).toBe('recording.wav');
  });

  it('keeps WAV blobs unchanged for funasr-asr', async () => {
    const input = new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/wav' });
    const result = await normalizeASRUploadAudio('funasr-asr', input);
    expect(result.blob).toBe(input);
    expect(result.fileName).toBe('recording.wav');
  });

  // Fork. A custom (OpenAI-compatible) ASR is often a LiteLLM gateway whose
  // decoder is libsndfile, which has no WebM: the browser's own recording came
  // back 422 "Format not recognised" while a WAV test file passed.
  it('converts a custom ASR recording to WAV', async () => {
    const samples = new Float32Array([0, 0.5, -0.5, 0]);
    class FakeAudioContext {
      async decodeAudioData() {
        return {
          sampleRate: 16000,
          length: samples.length,
          numberOfChannels: 1,
          getChannelData: () => samples,
        };
      }
      async close() {}
    }
    vi.stubGlobal('window', { AudioContext: FakeAudioContext });
    try {
      const input = new Blob([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3])], { type: 'audio/webm' });
      const result = await normalizeASRUploadAudio('custom-asr-1789352911816', input);
      expect(result.fileName).toBe('recording.wav');
      expect(result.blob.type).toBe('audio/wav');
      const header = new Uint8Array(await result.blob.arrayBuffer()).slice(0, 12);
      expect(String.fromCharCode(...header.slice(0, 4))).toBe('RIFF');
      expect(String.fromCharCode(...header.slice(8, 12))).toBe('WAVE');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
