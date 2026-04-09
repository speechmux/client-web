/**
 * PcmProcessor — AudioWorklet that converts Float32 mic input to PCM S16LE
 * and posts Int16Array chunks to the main thread.
 *
 * Registered as "pcm-processor" in AudioWorkletNode.
 */
class PcmProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [];
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;

    const float32 = input[0];
    const int16 = new Int16Array(float32.length);
    for (let i = 0; i < float32.length; i++) {
      const sample = Math.max(-1, Math.min(1, float32[i]));
      int16[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
    }

    this.port.postMessage(int16.buffer, [int16.buffer]);
    return true;
  }
}

registerProcessor("pcm-processor", PcmProcessor);
