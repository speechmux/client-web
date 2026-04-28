"use client";

import { useCallback, useEffect, useRef } from "react";
import { TARGET_SAMPLE_RATE, decodeAudioFileToPcm16, downsample, floatToInt16, chunkInt16 } from "@/lib/audio-utils";

/** PCM chunk size in samples (80ms at 16kHz). */
const CHUNK_SAMPLES = (TARGET_SAMPLE_RATE * 80) / 1000;

export type InputMode = "mic" | "file";

export interface AudioCaptureProps {
  mode: InputMode;
  isRunning: boolean;
  /** Called with each PCM S16LE chunk as it becomes available. */
  onAudioChunk: (chunk: Int16Array) => void;
  /** Called when the audio source has no more data (file end). */
  onAudioEnd: () => void;
  onError: (message: string) => void;
  /** Called with RMS level 0–1, throttled to ~15fps. Mic mode only. */
  onRmsLevel?: (level: number) => void;
  /** Called with sent ratio 0–1 during file transfer. File mode only. */
  onUploadProgress?: (ratio: number) => void;
}

interface MicCaptureState {
  audioContext: AudioContext | null;
  sourceNode: MediaStreamAudioSourceNode | null;
  workletNode: AudioWorkletNode | null;
  /** ScriptProcessorNode fallback for Safari. */
  processorNode: ScriptProcessorNode | null;
  mediaStream: MediaStream | null;
}

const EMPTY_MIC_STATE: MicCaptureState = {
  audioContext: null,
  sourceNode: null,
  workletNode: null,
  processorNode: null,
  mediaStream: null,
};

function computeRms(int16: Int16Array): number {
  let sum = 0;
  for (let i = 0; i < int16.length; i++) {
    const s = int16[i]! / 32768;
    sum += s * s;
  }
  return Math.sqrt(sum / int16.length);
}

function computeRmsFloat(float32: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < float32.length; i++) sum += float32[i]! ** 2;
  return Math.sqrt(sum / float32.length);
}

/**
 * AudioCapture manages microphone or file audio input and emits PCM chunks.
 *
 * For microphone input, AudioWorklet is used (with ScriptProcessorNode as
 * a fallback for Safari which may not support AudioWorklet).
 * For file input, the file is decoded in-browser via AudioContext and
 * streamed at real-time pace.
 */
export function useAudioCapture({
  mode,
  isRunning,
  onAudioChunk,
  onAudioEnd,
  onError,
  onRmsLevel,
  onUploadProgress,
}: AudioCaptureProps): {
  startMic: () => Promise<void>;
  stopMic: () => void;
  sendFile: (file: File, realtimePacing: boolean) => Promise<void>;
  cancelFile: () => void;
} {
  const micStateRef = useRef<MicCaptureState>({ ...EMPTY_MIC_STATE });
  const fileCancelRef = useRef<boolean>(false);
  const lastRmsEmitRef = useRef<number>(0);

  // propsRef keeps all callbacks current so closures registered in startMic
  // (AudioWorklet/ScriptProcessorNode handlers) always read the latest values
  // without being stale captures from the render that called startMic.
  const propsRef = useRef<AudioCaptureProps>({
    mode,
    isRunning,
    onAudioChunk,
    onAudioEnd,
    onError,
    onRmsLevel,
    onUploadProgress,
  });
  useEffect(() => {
    propsRef.current = { mode, isRunning, onAudioChunk, onAudioEnd, onError, onRmsLevel, onUploadProgress };
  });

  const stopMic = useCallback(() => {
    const state = micStateRef.current;
    // Null the message handlers first so that any messages already in the
    // browser's event queue are silently dropped after this point.
    if (state.workletNode) {
      state.workletNode.port.onmessage = null;
    }
    if (state.processorNode) {
      state.processorNode.onaudioprocess = null;
    }
    state.workletNode?.disconnect();
    state.processorNode?.disconnect();
    state.sourceNode?.disconnect();
    state.audioContext?.close().catch(() => null);
    state.mediaStream?.getTracks().forEach((track) => track.stop());
    micStateRef.current = { ...EMPTY_MIC_STATE };
  }, []);

  const startMic = useCallback(async () => {
    if (!window.isSecureContext) {
      throw new Error(
        "Microphone requires HTTPS or localhost. Switch to file mode or use a secure context."
      );
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error(
        "getUserMedia is not available. Check browser permissions and secure context."
      );
    }

    const mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        sampleRate: TARGET_SAMPLE_RATE,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });

    // Detect unexpected microphone disconnection (e.g. device unplugged).
    // Guard: only call onError if micStateRef still references this stream —
    // when stopMic() is called intentionally it clears micStateRef first,
    // so the 'ended' event fired by track.stop() is silently ignored.
    for (const track of mediaStream.getTracks()) {
      track.addEventListener("ended", () => {
        if (micStateRef.current.mediaStream === mediaStream) {
          propsRef.current.onError("Microphone disconnected. The audio device may have been unplugged.");
        }
      });
    }

    const AudioContextClass =
      (window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext })
        .AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;

    if (!AudioContextClass) {
      throw new Error("AudioContext is not supported in this browser.");
    }

    const audioContext = new AudioContextClass();
    await audioContext.resume();

    const sourceNode = audioContext.createMediaStreamSource(mediaStream);
    const actualRate = audioContext.sampleRate;

    let captureSucceeded = false;

    // Prefer AudioWorklet; fall back to deprecated ScriptProcessorNode on Safari.
    try {
      await audioContext.audioWorklet.addModule("/pcm-processor.js");
      const workletNode = new AudioWorkletNode(audioContext, "pcm-processor");

      workletNode.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
        const int16 = new Int16Array(event.data);
        // The worklet already converts float→int16 but at the context sample rate.
        // If the context rate != 16kHz, we need to downsample.
        // If sample rate matches, use the int16 data directly.
        // Otherwise, convert int16 → float32 (new buffer) before downsampling.
        // NOTE: reusing int16.buffer as Float32Array is invalid — Float32 needs 4 bytes/element
        // but Int16 only provides 2, causing RangeError on Safari/iOS.
        const chunk =
          actualRate === TARGET_SAMPLE_RATE
            ? int16
            : (() => {
                const float32 = new Float32Array(int16.length);
                for (let i = 0; i < int16.length; i++) {
                  const s = int16[i]!;
                  float32[i] = s / (s < 0 ? 0x8000 : 0x7fff);
                }
                return floatToInt16(downsample(float32, actualRate, TARGET_SAMPLE_RATE));
              })();
        propsRef.current.onAudioChunk(chunk);

        const { onRmsLevel: rmsCallback } = propsRef.current;
        if (rmsCallback) {
          const now = Date.now();
          if (now - lastRmsEmitRef.current >= 67) {
            lastRmsEmitRef.current = now;
            rmsCallback(Math.min(1, computeRms(int16) * 6));
          }
        }
      };

      sourceNode.connect(workletNode);
      workletNode.connect(audioContext.destination);

      micStateRef.current = {
        audioContext,
        sourceNode,
        workletNode,
        processorNode: null,
        mediaStream,
      };
      captureSucceeded = true;
    } catch {
      // AudioWorklet not available (Safari) — fall back to ScriptProcessorNode.
      // ScriptProcessorNode is deprecated but still functional in Safari.
      // See: https://developer.mozilla.org/en-US/docs/Web/API/ScriptProcessorNode
      const processorNode = audioContext.createScriptProcessor(4096, 1, 1);
      processorNode.onaudioprocess = (event: AudioProcessingEvent) => {
        const float32 = event.inputBuffer.getChannelData(0);
        const resampled = downsample(float32, actualRate, TARGET_SAMPLE_RATE);
        propsRef.current.onAudioChunk(floatToInt16(resampled));

        const { onRmsLevel: rmsCallback } = propsRef.current;
        if (rmsCallback) {
          const now = Date.now();
          if (now - lastRmsEmitRef.current >= 67) {
            lastRmsEmitRef.current = now;
            rmsCallback(Math.min(1, computeRmsFloat(float32) * 6));
          }
        }
      };
      sourceNode.connect(processorNode);
      processorNode.connect(audioContext.destination);

      micStateRef.current = {
        audioContext,
        sourceNode,
        workletNode: null,
        processorNode,
        mediaStream,
      };
      captureSucceeded = true;
    }

    if (!captureSucceeded) {
      audioContext.close().catch(() => null);
      mediaStream.getTracks().forEach((track) => track.stop());
      throw new Error("Failed to initialize audio capture.");
    }
  }, []);

  const sendFile = useCallback(
    async (file: File, realtimePacing: boolean) => {
      fileCancelRef.current = false;
      let pcm16: Int16Array;
      try {
        pcm16 = await decodeAudioFileToPcm16(file);
      } catch (decodeError) {
        propsRef.current.onError(String(decodeError));
        return;
      }

      const totalChunks = Math.ceil(pcm16.length / CHUNK_SAMPLES);
      let chunkIndex = 0;

      for (const chunk of chunkInt16(pcm16, CHUNK_SAMPLES)) {
        if (fileCancelRef.current) return;
        propsRef.current.onAudioChunk(chunk);
        chunkIndex++;
        propsRef.current.onUploadProgress?.(chunkIndex / totalChunks);
        if (realtimePacing) {
          const chunkDurationMs = (chunk.length / TARGET_SAMPLE_RATE) * 1000;
          await new Promise<void>((resolve) => setTimeout(resolve, chunkDurationMs));
        } else {
          // Yield to the event loop periodically to avoid blocking the UI thread.
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
        }
      }

      if (!fileCancelRef.current) {
        propsRef.current.onUploadProgress?.(1.0);
        propsRef.current.onAudioEnd();
      }
    },
    [],
  );

  const cancelFile = useCallback(() => {
    fileCancelRef.current = true;
  }, []);

  // Stop mic when isRunning transitions to false.
  useEffect(() => {
    if (!isRunning && mode === "mic") {
      stopMic();
    }
  }, [isRunning, mode, stopMic]);

  // Cleanup on unmount.
  useEffect(() => {
    return () => {
      stopMic();
      fileCancelRef.current = true;
    };
  }, [stopMic]);

  return { startMic, stopMic, sendFile, cancelFile };
}
