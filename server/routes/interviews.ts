import path from 'path';
import { randomBytes } from 'crypto';
import { Router, type Request, type Response } from 'express';
import { AccessToken, TrackSource } from 'livekit-server-sdk';
import type { ServerConfig } from '../types';
import type { AuthService, User } from '../services/authService';
import { AuthError } from '../services/authService';
import type { ReportService } from '../services/reportService';
import type { Difficulty } from '../services/evaluationTypes';
import type { Decision, PlannedQuestion } from '../services/reportTypes';
import {
  SESSION_ID_PATTERN,
  type InterviewSession,
  type ParticipantRole,
  type SessionManager,
} from '../services/sessionManager';

const WEB_DIR = path.join(process.cwd(), 'web');
const LIVEKIT_CLIENT = path.join(process.cwd(), 'node_modules', 'livekit-client', 'dist', 'livekit-client.esm.mjs');
const EMAIL_PATTERN = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
const QUESTION_ID = /^q_\d{3}_[0-9a-f]{6}$/;
const ASSETS = new Set(['room.js', 'room.css', 'evaluation.js', 'report.js', 'pages.css']);
const DIFFICULTIES: Difficulty[] = ['easy', 'medium', 'hard'];
const DECISIONS: Decision[] = ['undecided', 'strong_hire', 'hire', 'no_hire', 'strong_no_hire'];

function isRole(value: unknown): value is ParticipantRole {
  return value === 'interviewer' || value === 'candidate';
}

function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const text = value.replace(/[\u0000-\u001F\u007F]/g, '').trim();
  return text && text.length <= max ? text : null;
}

function cleanList(value: unknown, maxItems: number, maxLen = 80): string[] {
  const items = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  return items.map((v) => cleanText(v, maxLen)).filter((v): v is string => !!v).slice(0, maxItems);
}

/** Tiny fixed-window limiter for endpoints that create state or check secrets. */
function rateLimiter(max: number, windowMs: number) {
  const hits = new Map<string, { count: number; resetAt: number }>();
  return (req: Request): boolean => {
    const key = req.ip ?? 'unknown';
    const now = Date.now();
    const entry = hits.get(key);
    if (!entry || entry.resetAt < now) {
      hits.set(key, { count: 1, resetAt: now + windowMs });
      return true;
    }
    entry.count++;
    return entry.count <= max;
  };
}

type Deps = {
  config: ServerConfig;
  sessions: SessionManager;
  auth: AuthService;
  reports: ReportService;
};

export function createInterviewRouter({ config, sessions, auth, reports }: Deps): Router {
  const router = Router();
  const allowCreate = rateLimiter(30, 10 * 60_000);
  const allowJoin = rateLimiter(120, 10 * 60_000);
  const allowAuth = rateLimiter(20, 10 * 60_000);

  const baseUrl = (req: Request) => config.publicBaseUrl ?? `${req.protocol}://${req.get('host')}`;
  const candidateUrl = (req: Request, s: InterviewSession) => `${baseUrl(req)}/interview/${s.id}/candidate?key=${s.candidateKey}`;
  const interviewerUrl = (req: Request, s: InterviewSession) => `${baseUrl(req)}/interview/${s.id}/interviewer`;

  /** Loads an interview the signed-in interviewer owns, or responds with 401/403/404. */
  function ownedSession(req: Request, res: Response): InterviewSession | null {
    const user = auth.currentUser(req);
    if (!user) {
      res.status(401).json({ error: 'Please sign in.', code: 'unauthenticated' });
      return null;
    }
    const id = String(req.params.sessionId);
    const session = SESSION_ID_PATTERN.test(id) ? sessions.get(id) : undefined;
    if (!session) {
      res.status(404).json({ error: 'This interview does not exist or has expired.', code: 'invalid_session' });
      return null;
    }
    if (session.details.ownerId !== user.id) {
      console.warn(`[security] ${user.id} denied access to ${id}`);
      res.status(403).json({ error: 'You do not have access to this interview.', code: 'forbidden' });
      return null;
    }
    return session;
  }

  // --- Pages (static shells; all data comes from authorized API calls) ---

  router.use(['/interview', '/room-assets', '/login', '/dashboard'], (_req, res, next) => {
    // Candidate links carry a key, so pages must never leak it via Referer.
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    next();
  });

  router.get('/', (_req, res) => res.redirect('/dashboard'));
  router.get('/login', (_req, res) => res.sendFile(path.join(WEB_DIR, 'login.html')));
  router.get('/dashboard', (_req, res) => res.sendFile(path.join(WEB_DIR, 'dashboard.html')));
  router.get('/interview/new', (_req, res) => res.sendFile(path.join(WEB_DIR, 'new.html')));

  router.get('/interview/:sessionId/report', (req, res) => {
    if (!SESSION_ID_PATTERN.test(req.params.sessionId)) {
      res.status(404).send('Report not found.');
      return;
    }
    res.sendFile(path.join(WEB_DIR, 'report.html'));
  });

  router.get('/interview/:sessionId/:role', (req, res) => {
    if (!SESSION_ID_PATTERN.test(req.params.sessionId) || !isRole(req.params.role)) {
      res.status(404).send('Interview link is not valid.');
      return;
    }
    res.sendFile(path.join(WEB_DIR, 'room', 'room.html'));
  });

  router.get('/room-assets/:file', (req, res) => {
    if (!ASSETS.has(req.params.file)) {
      res.status(404).end();
      return;
    }
    const dir = req.params.file === 'pages.css' || req.params.file === 'report.js' ? WEB_DIR : path.join(WEB_DIR, 'room');
    res.sendFile(path.join(dir, req.params.file));
  });

  // Served from node_modules so the room works without a CDN.
  router.get('/vendor/livekit-client.esm.mjs', (_req, res) => {
    res.type('text/javascript').sendFile(LIVEKIT_CLIENT);
  });

  // --- Auth ---

  router.post('/api/auth/signup', async (req, res) => {
    if (!allowAuth(req)) {
      res.status(429).json({ error: 'Too many attempts. Try again later.' });
      return;
    }
    try {
      const user = await auth.signup(req.body?.email, req.body?.password, req.body?.name);
      await auth.startSession(res, user);
      console.log(`[auth] Account created ${user.id}`);
      res.status(201).json({ user: auth.toPublic(user) });
    } catch (err) {
      const status = err instanceof AuthError ? err.status : 500;
      res.status(status).json({ error: err instanceof AuthError ? err.message : 'Could not create the account.' });
    }
  });

  router.post('/api/auth/login', async (req, res) => {
    if (!allowAuth(req)) {
      res.status(429).json({ error: 'Too many attempts. Try again later.' });
      return;
    }
    try {
      const user = await auth.login(req.body?.email, req.body?.password);
      await auth.startSession(res, user);
      res.json({ user: auth.toPublic(user) });
    } catch (err) {
      const status = err instanceof AuthError ? err.status : 500;
      res.status(status).json({ error: err instanceof AuthError ? err.message : 'Could not sign in.' });
    }
  });

  router.post('/api/auth/logout', async (req, res) => {
    await auth.endSession(req, res);
    res.json({ ok: true });
  });

  // Signed-out is a normal state here, not an error.
  router.get('/api/auth/me', (req, res) => {
    const user = auth.currentUser(req);
    res.json({ user: user ? auth.toPublic(user) : null });
  });

  // --- Interviews ---

  router.get('/api/interviews', auth.requireUser, (req, res) => {
    const user = res.locals.user as User;
    res.json({
      interviews: sessions.listByOwner(user.id).map((s) => ({
        sessionId: s.id,
        candidateName: s.details.candidateName,
        position: s.details.position,
        status: s.status,
        createdAt: s.createdAt,
        startedAt: s.startedAt,
        endedAt: s.endedAt,
        durationMinutes: s.details.durationMinutes,
        questionsAsked: s.questions.length,
        reportStatus: s.reportStatus,
        averageScore: s.report?.averageFinalScore ?? null,
        decision: s.review.decision,
        interviewerUrl: interviewerUrl(req, s),
        candidateUrl: candidateUrl(req, s),
      })),
    });
  });

  router.post('/api/interviews', auth.requireUser, (req, res) => {
    if (!allowCreate(req)) {
      res.status(429).json({ error: 'Too many interviews created. Try again later.' });
      return;
    }
    const user = res.locals.user as User;
    const body = req.body ?? {};
    const candidateName = cleanText(body.candidateName, 80);
    const position = cleanText(body.position, 100);
    const candidateEmail = body.candidateEmail === undefined || body.candidateEmail === ''
      ? null
      : cleanText(body.candidateEmail, 254);
    const duration = body.durationMinutes === undefined ? 30 : Number(body.durationMinutes);
    const difficulty = body.difficulty === undefined ? 'medium' : body.difficulty;

    const errors: string[] = [];
    if (!candidateName) errors.push('candidateName is required (max 80 characters).');
    if (!position) errors.push('position is required (max 100 characters).');
    if (body.candidateEmail && (!candidateEmail || !EMAIL_PATTERN.test(candidateEmail))) {
      errors.push('candidateEmail is not a valid email address.');
    }
    if (!Number.isInteger(duration) || duration < 5 || duration > 240) {
      errors.push('durationMinutes must be a whole number between 5 and 240.');
    }
    if (!DIFFICULTIES.includes(difficulty)) errors.push('difficulty must be easy, medium or hard.');
    if (body.allowCandidateScreenShare !== undefined && typeof body.allowCandidateScreenShare !== 'boolean') {
      errors.push('allowCandidateScreenShare must be true or false.');
    }
    if (body.plannedQuestions !== undefined && (!Array.isArray(body.plannedQuestions) || body.plannedQuestions.length > 30)) {
      errors.push('plannedQuestions must be a list of at most 30 questions.');
    }
    const skills = cleanList(body.skills, 10);
    const plannedQuestions: PlannedQuestion[] = [];
    for (const [i, raw] of (Array.isArray(body.plannedQuestions) ? body.plannedQuestions : []).entries()) {
      const text = cleanText(raw?.text, 1000);
      if (!text) {
        errors.push(`Planned question ${i + 1} needs text (max 1000 characters).`);
        continue;
      }
      plannedQuestions.push({
        id: `pq_${randomBytes(4).toString('hex')}`,
        text,
        expectedConcepts: cleanList(raw.expectedConcepts, 10, 120),
        skills: cleanList(raw.skills, 4),
        difficulty: DIFFICULTIES.includes(raw.difficulty) ? raw.difficulty : difficulty,
        askedQuestionId: null,
      });
    }
    if (errors.length) {
      res.status(400).json({ error: errors.join(' ') });
      return;
    }

    const session = sessions.createInterview({
      ownerId: user.id,
      candidateName: candidateName!,
      candidateEmail,
      interviewerName: user.name,
      position: position!,
      durationMinutes: duration,
      allowCandidateScreenShare: body.allowCandidateScreenShare ?? true,
      skills,
      difficulty,
      plannedQuestions,
    });
    console.log(`[interview] ${user.id} created ${session.id} (${duration} min, ${plannedQuestions.length} planned)`);

    res.status(201).json({
      sessionId: session.id,
      status: session.status,
      interviewerUrl: interviewerUrl(req, session),
      candidateUrl: candidateUrl(req, session),
    });
  });

  // Exchanges credentials for a LiveKit token and a WebSocket participantKey.
  // Interviewer: signed-in owner. Candidate: the key from the invite link.
  router.post('/api/interviews/:sessionId/join', async (req, res) => {
    if (!allowJoin(req)) {
      res.status(429).json({ error: 'Too many join attempts. Try again later.' });
      return;
    }
    const { sessionId } = req.params;
    const { role, key } = req.body ?? {};
    const session = SESSION_ID_PATTERN.test(sessionId) ? sessions.get(sessionId) : undefined;

    if (!session || !session.details.ownerId) {
      res.status(404).json({ error: 'This interview does not exist or has expired.', code: 'invalid_session' });
      return;
    }
    if (role === 'interviewer') {
      const user = auth.currentUser(req);
      if (!user) {
        res.status(401).json({ error: 'Sign in to join as the interviewer.', code: 'unauthenticated' });
        return;
      }
      if (user.id !== session.details.ownerId) {
        console.warn(`[security] ${user.id} tried to join ${sessionId} as interviewer`);
        res.status(403).json({ error: 'This interview belongs to another interviewer.', code: 'forbidden' });
        return;
      }
    } else if (role !== 'candidate' || typeof key !== 'string' || !sessions.checkCandidateKey(session, key)) {
      console.warn(`[security] Unauthorized join attempt for ${sessionId}`);
      res.status(403).json({ error: 'This link is not valid for this interview.', code: 'unauthorized' });
      return;
    }
    if (sessions.isEnded(session)) {
      res.status(410).json({
        error: session.status === 'CANCELLED' ? 'This interview was cancelled.' : 'This interview has already been completed.',
        code: 'ended',
        status: session.status,
      });
      return;
    }
    if (!config.livekitUrl || !config.livekitApiKey || !config.livekitApiSecret) {
      res.status(503).json({ error: 'Video service is not configured on the server.', code: 'livekit_unavailable' });
      return;
    }

    const snapshot = sessions.snapshot(session);
    const name = snapshot.participants[role as ParticipantRole].name;
    const identity = `${role}_${session.id}`; // one identity per role: reconnects replace, never duplicate
    const sources = [TrackSource.CAMERA, TrackSource.MICROPHONE];
    if (role === 'interviewer' || session.details.allowCandidateScreenShare) {
      sources.push(TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO);
    }

    try {
      const at = new AccessToken(config.livekitApiKey, config.livekitApiSecret, {
        identity,
        name,
        ttl: Math.ceil(sessions.durationMs(session) / 1000) + 2 * 3600,
        metadata: JSON.stringify({ role }),
      });
      at.addGrant({
        room: session.roomName,
        roomJoin: true,
        canPublish: true,
        canSubscribe: true,
        canPublishData: true,
        canPublishSources: sources,
      });
      const token = await at.toJwt();
      const participantKey = sessions.addParticipant(session.id, role as ParticipantRole, name);
      console.log(`[interview] ${role} token issued for ${session.id}`);

      res.json({
        sessionId: session.id,
        role,
        name,
        identity,
        participantKey,
        livekit: { url: config.livekitUrl, token },
        interview: snapshot,
        ...(role === 'interviewer' ? { candidateUrl: candidateUrl(req, session) } : {}),
      });
    } catch (err) {
      console.error('[interview] Token generation failed:', (err as Error).message);
      res.status(500).json({ error: 'Could not prepare the video session.', code: 'livekit_unavailable' });
    }
  });

  // --- Report (owner only) ---

  router.get('/api/interviews/:sessionId/report', (req, res) => {
    const s = ownedSession(req, res);
    if (!s) return;
    res.json({
      sessionId: s.id,
      status: s.status,
      details: {
        candidateName: s.details.candidateName,
        candidateEmail: s.details.candidateEmail,
        position: s.details.position,
        interviewerName: s.details.interviewerName,
        skills: s.details.skills,
        difficulty: s.details.difficulty,
        durationMinutes: s.details.durationMinutes,
      },
      createdAt: s.createdAt,
      startedAt: s.startedAt,
      endedAt: s.endedAt,
      reportStatus: s.reportStatus,
      report: s.report,
      review: s.review,
      generalNotes: s.generalNotes,
      questions: s.questions,
      transcript: s.transcript,
    });
  });

  router.post('/api/interviews/:sessionId/report', (req, res) => {
    const s = ownedSession(req, res);
    if (!s) return;
    if (!sessions.isEnded(s)) {
      res.status(409).json({ error: 'The report is generated after the interview ends.' });
      return;
    }
    if (s.reportStatus === 'generating') {
      res.status(409).json({ error: 'The report is already being generated.' });
      return;
    }
    void reports.generate(s);
    res.status(202).json({ reportStatus: 'generating' });
  });

  // Human-controlled conclusions: decision, final score and notes.
  router.put('/api/interviews/:sessionId/review', (req, res) => {
    const s = ownedSession(req, res);
    if (!s) return;
    const body = req.body ?? {};
    const decision = body.decision ?? s.review.decision;
    const finalScore = body.finalScore === undefined ? s.review.finalScore : body.finalScore;
    if (!DECISIONS.includes(decision)) {
      res.status(400).json({ error: 'Unknown decision.' });
      return;
    }
    if (finalScore !== null && (!Number.isInteger(finalScore) || finalScore < 0 || finalScore > 100)) {
      res.status(400).json({ error: 'Final score must be a whole number from 0 to 100, or empty.' });
      return;
    }
    for (const field of ['notes', 'comments'] as const) {
      if (body[field] !== undefined && (typeof body[field] !== 'string' || body[field].length > 8000)) {
        res.status(400).json({ error: `${field} must be text up to 8000 characters.` });
        return;
      }
    }
    const user = auth.currentUser(req)!; // ownership already verified
    s.review = {
      decision,
      finalScore,
      notes: body.notes ?? s.review.notes,
      comments: body.comments ?? s.review.comments,
      updatedAt: Date.now(),
      updatedBy: user.name,
    };
    res.json({ review: s.review });
  });

  // Private notes can still be edited after the interview (general or per question).
  router.put('/api/interviews/:sessionId/notes', (req, res) => {
    const s = ownedSession(req, res);
    if (!s) return;
    const { questionId, text } = req.body ?? {};
    if (typeof text !== 'string' || text.length > 4000) {
      res.status(400).json({ error: 'Notes must be text up to 4000 characters.' });
      return;
    }
    if (questionId === undefined || questionId === null) {
      s.generalNotes = text;
    } else {
      const q = typeof questionId === 'string' && QUESTION_ID.test(questionId)
        ? s.questions.find((x) => x.questionId === questionId)
        : undefined;
      if (!q) {
        res.status(404).json({ error: 'Unknown question.' });
        return;
      }
      q.interviewerNote = text;
    }
    res.json({ ok: true });
  });

  return router;
}
