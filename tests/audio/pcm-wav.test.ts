import { describe, expect, it } from 'vitest';

import { decodeAudioResponse } from '@/lib/audio/tts-providers';

/** Read a little-endian field the way a WAV parser would. */
const u32 = (b: Uint8Array, o: number) => new DataView(b.buffer, b.byteOffset).getUint32(o, true);
const u16 = (b: Uint8Array, o: number) => new DataView(b.buffer, b.byteOffset).getUint16(o, true);
const tag = (b: Uint8Array, o: number) => String.fromCharCode(...b.slice(o, o + 4));

/** 100 frames of silence — content does not matter, only the framing does. */
const pcm = () => new Uint8Array(200).buffer;

/** A smooth 200 Hz ramp — what speech looks like: consecutive samples move little. */
function tone(order: 'little' | 'big', frames = 400): ArrayBuffer {
  const buf = new ArrayBuffer(frames * 2);
  const view = new DataView(buf);
  for (let i = 0; i < frames; i++) {
    view.setInt16(i * 2, Math.round(8000 * Math.sin((i / 60) * Math.PI)), order === 'little');
  }
  return buf;
}

describe('decodeAudioResponse byte order', () => {
  const samples = (wav: Uint8Array) =>
    new DataView(wav.buffer, wav.byteOffset + 44).getInt16(0, true);

  it('leaves little-endian L16 alone — what real gateways send', () => {
    const { audio } = decodeAudioResponse(tone('little'), 'audio/L16;rate=24000');
    // First sample is sin(0) = 0 either way; check a later one that is not.
    const v = new DataView(audio.buffer, audio.byteOffset + 44).getInt16(30 * 2, true);
    expect(Math.abs(v)).toBeLessThan(9000);
  });

  it('swaps big-endian L16 — what RFC 2586 actually specifies', () => {
    const { audio } = decodeAudioResponse(tone('big'), 'audio/L16;rate=24000');
    const v = new DataView(audio.buffer, audio.byteOffset + 44).getInt16(30 * 2, true);
    expect(Math.abs(v)).toBeLessThan(9000);
  });

  it('never swaps audio/pcm, which is little-endian by definition', () => {
    const buf = tone('big');
    const { audio } = decodeAudioResponse(buf, 'audio/pcm;rate=24000');
    expect(new Uint8Array(audio.buffer, audio.byteOffset + 44, 4)).toEqual(
      new Uint8Array(buf, 0, 4),
    );
  });

  it('falls back to the specification when there is too little to measure', () => {
    const buf = tone('big', 8);
    const { audio, format } = decodeAudioResponse(buf, 'audio/L16');
    expect(format).toBe('wav');
    expect(audio.length).toBe(44 + 16);
  });

  it('does not choke on silence', () => {
    const { format } = decodeAudioResponse(new ArrayBuffer(400), 'audio/L16');
    expect(format).toBe('wav');
  });

  void samples;
});

describe('decodeAudioResponse', () => {
  it('wraps audio/L16 in a WAV container', () => {
    const { audio, format } = decodeAudioResponse(pcm(), 'audio/L16;rate=24000;channels=1');

    expect(format).toBe('wav');
    expect(audio.length).toBe(244); // 44-byte header + 200 bytes of samples
    expect(tag(audio, 0)).toBe('RIFF');
    expect(tag(audio, 8)).toBe('WAVE');
    expect(tag(audio, 12)).toBe('fmt ');
    expect(tag(audio, 36)).toBe('data');
    expect(u32(audio, 4)).toBe(236); // 36 + data length
    expect(u16(audio, 20)).toBe(1); // uncompressed PCM
    expect(u16(audio, 22)).toBe(1); // channels
    expect(u32(audio, 24)).toBe(24_000); // sample rate
    expect(u32(audio, 28)).toBe(48_000); // byte rate = rate * channels * 2
    expect(u16(audio, 32)).toBe(2); // block align
    expect(u16(audio, 34)).toBe(16); // bits per sample
    expect(u32(audio, 40)).toBe(200); // data length
  });

  it('honours rate and channels from the media type', () => {
    const { audio } = decodeAudioResponse(pcm(), 'audio/pcm; rate=48000; channels=2');
    expect(u32(audio, 24)).toBe(48_000);
    expect(u16(audio, 22)).toBe(2);
    expect(u32(audio, 28)).toBe(192_000); // 48000 * 2 channels * 2 bytes
    expect(u16(audio, 32)).toBe(4);
  });

  it('falls back to 24 kHz mono when the media type omits them', () => {
    const { audio } = decodeAudioResponse(pcm(), 'audio/x-pcm');
    expect(u32(audio, 24)).toBe(24_000);
    expect(u16(audio, 22)).toBe(1);
  });

  it('leaves container formats alone', () => {
    for (const [type, expected] of [
      ['audio/mpeg', 'mp3'],
      ['audio/wav', 'wav'],
      ['audio/ogg', 'ogg'],
    ] as const) {
      const { audio, format } = decodeAudioResponse(pcm(), type);
      expect(format).toBe(expected);
      expect(audio.length).toBe(200); // untouched — no header prepended
    }
  });

  it('does not mistake a container type that merely mentions pcm', () => {
    // The guard matches the media type, not a substring: `audio/wav` carrying
    // PCM samples is already a container and must not be wrapped twice.
    const { audio, format } = decodeAudioResponse(pcm(), 'audio/wav; codec=pcm');
    expect(format).toBe('wav');
    expect(audio.length).toBe(200);
  });
});
