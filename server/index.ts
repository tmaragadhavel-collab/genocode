import express from 'express';
import cors from 'cors';
import http from 'http';
import path from 'path';
import { WebSocketServer, WebSocket } from 'ws';
import { AccessToken } from 'livekit-server-sdk';
import { loadConfig } from './config';
import { LLMClient } from './llm/llmClient';
import { loadLLMConfig } from './llm/config';
import { generateAssistantStream } from './llm/assistantStream';
import { DeepgramStreamingService } from './services/deepgramSTT';
import { ConversationEngine } from './services/conversationEngine';
import { SessionManager, type ParticipantRole } from './services/sessionManager';
import { LLMService } from './services/llmService';
import { ChatHandler, type ChatClient, type ChatOutbound } from './services/chatHandler';
import { InterviewRealtime, type RealtimeClient } from './services/interviewRealtime';
import { EvaluationService } from './services/evaluationService';
import { QuestionFlow } from './services/questionFlow';
import { AuthService } from './services/authService';
import { ReportService } from './services/reportService';
import { getPrisma, assertDatabaseReady } from './db/prisma';
import { InterviewRepository } from './db/interviewRepository';
import { createInterviewRouter } from './routes/interviews';
import type { WSMessage, StreamChunk, TranscriptEntry, SessionState } from './types';

const config = loadConfig();
const app = express();
const server = http.createServer(app);
// Audio frames are ~11 KB of base64; 1 MB leaves ample headroom while bounding abuse.
const wss = new WebSocketServer({ server, maxPayload: 1024 * 1024 });

app.use(cors());
app.use(express.json({ limit: '32kb' }));


let sessionState: SessionState = 'idle';
let aiGenerating = false;
let sttService: DeepgramStreamingService | null = null;
let interviewerAudioCount = 0;
let candidateAudioCount = 0;
let audioDropWarned = false;

const conversationEngine = new ConversationEngine();
// The single LLM client used by chat, evaluation, follow-ups, reports and the live assistant.
const llm = new LLMClient(loadLLMConfig());
console.log(`[LLM] ${llm.describe}`);

// --- Per-connection state ---

// 'app' = the candidate desktop app (the only view that gets the private feed);
// 'room' = the browser interview room; 'interviewer' = legacy interviewer page.
type ClientView = 'app' | 'room' | 'interviewer';

type ClientState = ChatClient & RealtimeClient & {
  view: ClientView;
};

const clients = new Map<WebSocket, ClientState>();

function sendJSON(ws: WebSocket, msg: WSMessage | ChatOutbound): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

// The private feed (transcript analysis, assistant stream, provider status)
// must never reach an interviewer or a browser interview room.
function receivesPrivateFeed(state: ClientState): boolean {
  return state.view === 'app' && state.binding?.role !== 'interviewer';
}

/** Candidate-app broadcast (transcripts, AI assistant stream, status). */
function broadcast(msg: WSMessage): void {
  const data = JSON.stringify(msg);
  clients.forEach((state, client) => {
    if (client.readyState === WebSocket.OPEN && receivesPrivateFeed(state)) {
      client.send(data);
    }
  });
}

/** Session events go only to connections joined to that interview session. */
function sendToSession(sessionId: string, msg: ChatOutbound): void {
  const data = JSON.stringify(msg);
  clients.forEach((state, client) => {
    if (client.readyState === WebSocket.OPEN && state.binding?.sessionId === sessionId) {
      client.send(data);
    }
  });
}

const prisma = getPrisma();
const sessions = new SessionManager(config.answerSilenceSeconds);
const interviews = new InterviewRepository(prisma);
const auth = new AuthService(prisma, Boolean(config.publicBaseUrl?.startsWith('https://')));
const llmService = new LLMService(llm);
const chatHandler = new ChatHandler(sessions, llmService, sendToSession, !config.isProduction);
/** Role-scoped delivery: evaluation data only ever goes to interviewer connections. */
function sendToRole(sessionId: string, role: ParticipantRole, msg: ChatOutbound): void {
  const data = JSON.stringify(msg);
  clients.forEach((state, client) => {
    if (client.readyState === WebSocket.OPEN
      && state.binding?.sessionId === sessionId
      && state.binding.role === role) {
      client.send(data);
    }
  });
}

const evaluator = new EvaluationService(llm);
const questionFlow = new QuestionFlow(
  sessions,
  evaluator,
  { toSession: sendToSession, toRole: sendToRole },
  config.stt
);
const reports = new ReportService(
  sessions,
  llm,
  (sessionId) => questionFlow.waitForEvaluations(sessionId),
  (session) => sendToRole(session.id, 'interviewer', { type: 'report_status', sessionId: session.id, reportStatus: session.reportStatus })
);
const realtime = new InterviewRealtime(
  sessions,
  sendToSession,
  (sessionId) => [...clients.values()].filter((c) => c.binding?.sessionId === sessionId),
  {
    joinData: (session, role) => questionFlow.joinData(session, role),
    onStatusChange: (session) => {
      if (!sessions.isEnded(session)) return;
      // Stop taking answers, evaluate the last one, then build the report in the background.
      questionFlow.onInterviewEnded(session);
      if (session.details.ownerId && (session.status === 'COMPLETED' || session.questions.length)) {
        void reports.generate(session);
      }
    },
  }
);

app.use(createInterviewRouter({ config, sessions, auth, reports }));

function now(): string {
  return new Date().toISOString();
}

function setSessionState(state: SessionState): void {
  sessionState = state;
  broadcast({ type: 'session_state', payload: { state }, timestamp: now() });
}

function broadcastAudioStatus(): void {
  broadcast({
    type: 'audio_status',
    payload: {
      systemAudio: sttService?.isInterviewerConnected() ? 'connected' : 'disconnected',
      microphone: sttService?.isCandidateConnected() ? 'connected' : 'disconnected',
      stt: config.deepgramKey ? (sttService ? 'connected' : 'disconnected') : 'disconnected',
      ai: llm.demoMode ? 'demo' : 'connected',
    },
    timestamp: now(),
  });
}

// --- REST endpoints ---

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'interview-backend',
    mode: config.demoMode ? 'demo' : 'live',
    providers: {
      stt: config.deepgramKey ? 'deepgram' : 'none',
      ai: llm.demoMode ? 'mock' : llm.primaryModel,
      livekit: config.livekitUrl ? 'configured' : 'none',
    },
    session: sessionState,
  });
});

// Interviewer join page (http://localhost:<port>/interviewer, or via an HTTPS tunnel for remote interviewers).
app.get('/interviewer', (_req, res) => {
  res.sendFile(path.join(process.cwd(), 'interviewer.html'));
});

app.get('/livekit/config', (_req, res) => {
  if (!config.livekitUrl) {
    res.status(503).json({ error: 'LiveKit not configured' });
    return;
  }
  res.json({ url: config.livekitUrl });
});

const NAME_PATTERN = /^[\w.@ -]{1,64}$/;

function isValidName(value: unknown): value is string {
  return typeof value === 'string' && NAME_PATTERN.test(value);
}

app.post('/livekit/token', (req, res) => {
  const { roomName, participantName, participantIdentity } = req.body ?? {};
  const role: ParticipantRole = req.body?.role === 'interviewer' ? 'interviewer' : 'candidate';
  console.log(`[livekit] Token request origin=${req.get('origin') || 'none'} room=${roomName} role=${role}`);

  if (!config.livekitApiKey || !config.livekitApiSecret) {
    res.status(503).json({ error: 'LiveKit credentials not configured' });
    return;
  }

  if (!isValidName(roomName) || !isValidName(participantName)
    || (participantIdentity !== undefined && !isValidName(participantIdentity))) {
    res.status(400).json({ error: 'roomName and participantName are required (letters, numbers, spaces, - _ . @; max 64)' });
    return;
  }
  // This unauthenticated desktop-app endpoint must never grant access to scheduled interview rooms.
  if (roomName.startsWith('interview_')) {
    console.warn('[security] Legacy token request for a scheduled interview room rejected');
    res.status(403).json({ error: 'This room name is reserved.' });
    return;
  }

  // Each room maps to one interview session; the participantKey proves this
  // client's session membership and role when it joins over WebSocket.
  const session = sessions.getOrCreateForRoom(roomName);
  const participantKey = sessions.addParticipant(session.id, role, participantName);

  const token = new AccessToken(config.livekitApiKey, config.livekitApiSecret, {
    identity: participantIdentity || participantName,
    name: participantName,
  });

  token.addGrant({
    room: roomName,
    roomJoin: true,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
  });

  const jwt = token.toJwt();
  jwt.then((t: string) => {
    res.json({ token: t, url: config.livekitUrl, sessionId: session.id, participantKey, role });
  }).catch((err: Error) => {
    console.error('[livekit] Token generation error:', err);
    res.status(500).json({ error: 'Failed to generate token' });
  });
});

// --- Transcript & AI pipeline ---

function handleTranscript(entry: TranscriptEntry): void {
  console.log(`[deepgram] Transcript ${entry.isFinal ? 'final' : 'partial'} (${entry.speaker}): ${entry.text}`);

  broadcast({
    type: 'transcript',
    payload: entry,
    timestamp: now(),
  });

  if (entry.speaker === 'interviewer' && entry.isFinal && entry.text.trim()) {
    setSessionState('interviewer_speaking');
  }

  conversationEngine.handleTranscript(entry);
}

conversationEngine.setQuestionHandler(async (question) => {
  console.log(`[conversation] Question detected: "${question.question}"`);

  broadcast({
    type: 'question',
    payload: question,
    timestamp: now(),
  });

  setSessionState('processing_question');
  await triggerAI();
});

async function triggerAI(): Promise<void> {
  if (aiGenerating) return;
  aiGenerating = true;

  setSessionState('ai_thinking');
  console.log('[llm] Processing question...');

  const context = conversationEngine.getContext();

  try {
    setSessionState('ai_streaming');
    await generateAssistantStream(llm, context, (chunk: StreamChunk) => {
      broadcast({
        type: 'assistant_stream',
        payload: chunk,
        timestamp: now(),
      });
    });
    console.log('[ai] Response complete');
    setSessionState('waiting_for_next_question');
  } catch (err) {
    console.error('[ai] Generation error:', err);
    broadcast({
      type: 'assistant_stream',
      payload: { type: 'error', content: 'AI generation failed' } as StreamChunk,
      timestamp: now(),
    });
    setSessionState('listening');
  } finally {
    aiGenerating = false;
  }
}

// --- STT management ---

function startSTT(): void {
  if (!config.deepgramKey) {
    console.log('[stt] No Deepgram key — STT not available');
    return;
  }

  sttService = new DeepgramStreamingService(
    { apiKey: config.deepgramKey },
    handleTranscript
  );

  interviewerAudioCount = 0;
  candidateAudioCount = 0;
  audioDropWarned = false;
  console.log('[stt] Starting Deepgram streams...');
  sttService.startInterviewerStream();
  sttService.startCandidateStream();

  setTimeout(broadcastAudioStatus, 1500);
}

function stopSTT(): void {
  sttService?.stop();
  sttService = null;
  broadcastAudioStatus();
}

// --- WebSocket ---

wss.on('connection', (ws, req) => {
  const viewParam = new URL(req.url ?? '/', 'http://localhost').searchParams.get('view');
  const view: ClientView = viewParam === 'room' || viewParam === 'interviewer' ? viewParam : 'app';
  const state: ClientState = {
    binding: null,
    media: null,
    sentAt: [],
    view,
    send: (msg) => sendJSON(ws, msg),
  };
  clients.set(ws, state);
  console.log(`[ws] Client connected (${view})`);

  ws.on('error', (err) => {
    console.warn('[ws] Socket error:', err.message);
  });

  if (view === 'app') {
    sendCandidateGreeting(ws);
  }

  ws.on('message', (raw) => {
    let msg: WSMessage & Record<string, unknown>;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      console.warn('[ws] Ignoring malformed JSON message');
      return;
    }
    if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') {
      console.warn('[ws] Ignoring message without a type');
      return;
    }

    try {
      switch (msg.type) {
        case 'session_join': {
          realtime.handleJoin(state, msg);
          break;
        }

        case 'interview_start':
        case 'interview_pause':
        case 'interview_resume':
        case 'interview_end':
        case 'interview_cancel': {
          realtime.handleControl(state, msg.type);
          break;
        }

        case 'participant_status': {
          realtime.handleParticipantStatus(state, msg);
          break;
        }

        // --- Question tracking & evaluation (interviewer-only; enforced in QuestionFlow) ---
        case 'question_start':
          questionFlow.handleQuestionStart(state, msg);
          break;
        case 'question_end':
          questionFlow.handleQuestionEnd(state);
          break;
        case 'transcript_partial':
        case 'transcript_final':
          questionFlow.handleClientTranscript(state, msg, msg.type === 'transcript_final');
          break;
        case 'room_audio':
          questionFlow.handleAudio(state, msg);
          break;
        case 'audio_segment':
          questionFlow.handleAudioSegment(state, msg);
          break;
        case 'speech_activity':
          questionFlow.handleSpeechActivity(state, msg);
          break;
        case 'evaluation_retry':
          questionFlow.handleRetry(state, msg);
          break;
        case 'evaluation_override':
          questionFlow.handleOverride(state, msg);
          break;
        case 'note_save':
          questionFlow.handleNote(state, msg);
          break;

        case 'ping': {
          state.send({ type: 'pong', serverNow: Date.now() });
          break;
        }

        case 'chat_message': {
          chatHandler.handle(state, msg).catch((err) => {
            console.error('[CHAT] Unexpected handler error:', (err as Error).message);
            state.send({ type: 'chat_error', message: 'AI response could not be generated. Please try again.' });
          });
          break;
        }

        case 'session_control':
        case 'audio_data':
          // The interviewer page never drives the candidate's STT pipeline.
          if (!receivesPrivateFeed(state)) break;
          handleCandidateControl(msg);
          break;

        default:
          console.warn(`[ws] Unknown message type: ${String(msg.type).slice(0, 40)}`);
          break;
      }
    } catch (err) {
      console.error(`[ws] Error handling ${String(msg.type).slice(0, 40)}:`, (err as Error).message);
    }
  });

  ws.on('close', () => {
    realtime.leave(state);
    clients.delete(ws);
    console.log('[ws] Client disconnected');
  });
});

function sendCandidateGreeting(ws: WebSocket): void {
  ws.send(JSON.stringify({
    type: 'connection_state',
    payload: {
      state: config.demoMode ? 'demo' : 'live',
      demoMode: config.demoMode,
      stt: config.deepgramKey ? 'deepgram' : 'none',
      ai: llm.demoMode ? 'mock' : llm.primaryModel,
      livekit: config.livekitUrl ? 'configured' : 'none',
      sessionState,
    },
    timestamp: now(),
  } satisfies WSMessage));

  broadcastAudioStatus();
}

// Existing candidate-app messages: session start/stop and audio for Deepgram.
function handleCandidateControl(msg: WSMessage): void {
  switch (msg.type) {
    case 'session_control': {
      const payload = msg.payload as { action: string };
      if (payload.action === 'start') {
        setSessionState('connecting');
        startSTT();
        setTimeout(() => {
          if (sessionState === 'connecting') setSessionState('listening');
        }, 2000);
      } else if (payload.action === 'stop') {
        stopSTT();
        conversationEngine.clear();
        setSessionState('idle');
      }
      break;
    }

    case 'audio_data': {
      const payload = msg.payload as { source: string; data: string };
      if (!sttService) {
        if (!audioDropWarned) {
          console.warn('[audio] Dropping audio — STT service not started');
          audioDropWarned = true;
        }
        break;
      }

      const buffer = Buffer.from(payload.data, 'base64');
      if (payload.source === 'system') {
        interviewerAudioCount++;
        if (interviewerAudioCount === 1 || interviewerAudioCount % 100 === 0) {
          console.log(`[audio] Interviewer packets received: ${interviewerAudioCount} (${buffer.length} bytes)`);
        }
        sttService.sendInterviewerAudio(buffer);
      } else if (payload.source === 'microphone') {
        candidateAudioCount++;
        if (candidateAudioCount === 1 || candidateAudioCount % 200 === 0) {
          console.log(`[audio] Candidate packets received: ${candidateAudioCount}`);
        }
        sttService.sendCandidateAudio(buffer);
      }
      break;
    }
  }
}

// --- Boot ---

async function boot(): Promise<void> {
  await assertDatabaseReady(prisma);
  await auth.init();
  const loaded = await interviews.loadAll();
  sessions.restore(loaded);
  const live = loaded.filter((s) => s.status === 'LIVE').length;
  console.log(`[db] Restored ${loaded.length} interview(s)${live ? `, ${live} still LIVE` : ''}`);
  interviews.start(() => sessions.persistable());

  // Flush pending writes before exiting.
  let stopping = false;
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, async () => {
      if (stopping) return;
      stopping = true;
      await interviews.stop(sessions.persistable());
      await prisma.$disconnect();
      process.exit(0);
    });
  }

  server.listen(config.port, () => {
    console.log(`\n[server] InterviewAI server running on http://localhost:${config.port}`);
    console.log(`[server] Mode: ${config.demoMode ? 'DEMO (no API keys)' : 'LIVE'}`);
    console.log(`[server] LiveKit: ${config.livekitUrl || 'NOT CONFIGURED'}`);
    console.log(`[server] WebSocket: ws://localhost:${config.port}`);
    console.log(`[server] Health: http://localhost:${config.port}/health\n`);
  });
}

boot().catch((err) => {
  console.error(`[server] Failed to start: ${(err as Error).message}`);
  process.exit(1);
});
