// AudioWorklet: converts the microphone to 16 kHz mono PCM16 in 100 ms chunks.
// Runs on the audio rendering thread (low latency, not throttled like timers).

const TARGET_RATE = 16000;
const CHUNK_SAMPLES = 1600; // 100 ms at 16 kHz

class Pcm16Capture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / TARGET_RATE; // e.g. 48000 / 16000 = 3
    this.pos = 0; // fractional read position into the input stream
    this.acc = 0; // running sum for box-filter averaging
    this.accCount = 0;
    this.out = new Int16Array(CHUNK_SAMPLES);
    this.outIndex = 0;
    this.sumSquares = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true; // no input yet (e.g. track just attached)

    for (let i = 0; i < channel.length; i++) {
      // Average the input samples that fall into each output sample (low-pass + decimate).
      this.acc += channel[i];
      this.accCount++;
      this.pos += 1;
      if (this.pos >= this.ratio) {
        this.pos -= this.ratio;
        const v = Math.max(-1, Math.min(1, this.acc / this.accCount));
        this.acc = 0;
        this.accCount = 0;
        this.out[this.outIndex++] = v < 0 ? v * 0x8000 : v * 0x7fff;
        this.sumSquares += v * v;
        if (this.outIndex === CHUNK_SAMPLES) {
          const level = Math.sqrt(this.sumSquares / CHUNK_SAMPLES);
          const buffer = this.out.buffer.slice(0);
          this.port.postMessage({ buffer, level }, [buffer]);
          this.outIndex = 0;
          this.sumSquares = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor('pcm16-capture', Pcm16Capture);
