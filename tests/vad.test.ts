// Server-side voice-activity detection on real speech (TTS fixture) and on noise.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Vad, type VadEvent } from '../server/stt/vad';

const speech = fs.readFileSync(path.join(__dirname, 'fixtures', 'answer-python.wav')).subarray(44);
const silence = (ms: number) => Buffer.alloc(Math.round(ms * 32));

function run(vad: Vad, audio: Buffer): VadEvent[] {
  const events: VadEvent[] = [];
  for (let i = 0; i < audio.length; i += 3200) events.push(...vad.process(audio.subarray(i, i + 3200))); // 100 ms frames
  return events;
}

test('detects speech and ends each utterance after silence', () => {
  const events = run(new Vad({ collectAudio: true }), Buffer.concat([silence(500), speech, silence(1200)]));
  const starts = events.filter((e) => e.type === 'speech_start').length;
  const ends = events.filter((e) => e.type === 'speech_end');
  assert.ok(starts >= 1, 'speech detected');
  assert.equal(ends.length, starts, 'every utterance ends');
  assert.ok(ends.every((e) => e.type === 'speech_end' && e.audio && e.audio.length > 16000), 'segment audio collected');
});

test('pure silence produces no speech', () => {
  assert.equal(run(new Vad(), silence(5000)).length, 0);
});

test('steady background noise is not treated as speech', () => {
  const noise = Buffer.alloc(32000 * 5);
  for (let i = 0; i < noise.length; i += 2) noise.writeInt16LE(Math.round((Math.random() - 0.5) * 2 * 150), i); // ~0.003 RMS hiss
  assert.equal(run(new Vad(), noise).filter((e) => e.type === 'speech_start').length, 0);
});

test('long speech is cut at the maximum segment length (latency bound)', () => {
  const long = Buffer.concat([speech, speech, speech]); // ~39 s with pauses
  const vad = new Vad({ collectAudio: true, maxSegmentMs: 4000, endSilenceMs: 5000 });
  const cuts = run(vad, long).filter((e) => e.type === 'speech_end' && e.reason === 'max_length');
  assert.ok(cuts.length >= 3, `expected several 4 s cuts, got ${cuts.length}`);
});
