// Sends a WAV file through the configured speech-to-text service and prints the result.
// Usage: npm run stt:sample -- [path/to/file.wav]   (default: tests/fixtures/process-vs-thread.wav)
import fs from 'fs';
import { loadConfig } from '../server/config';
import { WhisperSTT } from '../server/stt/whisper';

async function main() {
  const file = process.argv[2] || 'tests/fixtures/process-vs-thread.wav';
  const config = loadConfig();
  if (config.stt.provider !== 'groq') {
    console.error(`STT_PROVIDER is "${config.stt.provider}"; this sample uses the Groq Whisper provider.`);
    process.exit(1);
  }
  const audio = fs.readFileSync(file);
  const stt = new WhisperSTT(config.stt);
  const started = Date.now();
  const result = await stt.transcribe(audio, 'sample.wav');
  console.log(`File: ${file} (${Math.round(audio.length / 1024)} KB)  Model: ${stt.model}  Time: ${Date.now() - started}ms`);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error(`Transcription failed (${err.code ?? 'error'}): ${err.message}`);
  process.exit(1);
});
