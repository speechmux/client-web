/** Audio utility functions shared across components. */

export const TARGET_SAMPLE_RATE = 16_000;
/** Max file size accepted by the browser before upload (100 MB). */
export const MAX_FILE_BYTES = 100 * 1024 * 1024;

/** Down-sample a Float32 buffer from inputRate to outputRate using linear interpolation. */
export function downsample(
  input: Float32Array,
  inputRate: number,
  outputRate: number
): Float32Array {
  if (outputRate >= inputRate) return input;
  const ratio = inputRate / outputRate;
  const outputLength = Math.round(input.length / ratio);
  const output = new Float32Array(outputLength);
  let inputOffset = 0;
  for (let i = 0; i < outputLength; i++) {
    const nextOffset = Math.round((i + 1) * ratio);
    let sum = 0;
    let count = 0;
    for (let j = inputOffset; j < nextOffset && j < input.length; j++) {
      sum += input[j]!;
      count++;
    }
    output[i] = sum / Math.max(1, count);
    inputOffset = nextOffset;
  }
  return output;
}

/** Convert a Float32 audio buffer to PCM S16LE (Int16Array). */
export function floatToInt16(input: Float32Array): Int16Array {
  const output = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const sample = Math.max(-1, Math.min(1, input[i]!));
    output[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return output;
}

/** Mix a multi-channel AudioBuffer down to a single mono Float32Array. */
export function mixToMono(audioBuffer: AudioBuffer): Float32Array {
  const { numberOfChannels, length } = audioBuffer;
  if (numberOfChannels === 1) {
    return audioBuffer.getChannelData(0);
  }
  const mono = new Float32Array(length);
  for (let channel = 0; channel < numberOfChannels; channel++) {
    const channelData = audioBuffer.getChannelData(channel);
    for (let i = 0; i < length; i++) {
      mono[i]! += channelData[i]! / numberOfChannels;
    }
  }
  return mono;
}

/**
 * Decode an audio file to PCM S16LE at TARGET_SAMPLE_RATE.
 *
 * Uses the Web Audio API to decode any browser-supported format (WAV, FLAC, MP3…).
 * The AudioContext is created and closed within this call to avoid leaks.
 */
export async function decodeAudioFileToPcm16(file: File): Promise<Int16Array> {
  if (file.size > MAX_FILE_BYTES) {
    throw new Error(`File exceeds maximum size of ${MAX_FILE_BYTES / 1024 / 1024} MB.`);
  }

  const AudioContextClass =
    (window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext })
      .AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;

  if (!AudioContextClass) {
    throw new Error("AudioContext is not supported in this browser.");
  }

  const bytes = await file.arrayBuffer();
  const context = new AudioContextClass();
  try {
    const audioBuffer = await context.decodeAudioData(bytes.slice(0));
    const mono = mixToMono(audioBuffer);
    const resampled = downsample(mono, audioBuffer.sampleRate, TARGET_SAMPLE_RATE);
    return floatToInt16(resampled);
  } catch {
    throw new Error(`Unsupported audio format or corrupt file: ${file.name}`);
  } finally {
    await context.close();
  }
}

/** Split a large Int16Array into fixed-size chunks. */
export function* chunkInt16(
  samples: Int16Array,
  chunkSize: number
): Generator<Int16Array> {
  let offset = 0;
  while (offset < samples.length) {
    yield samples.subarray(offset, offset + chunkSize);
    offset += chunkSize;
  }
}
