import {
  Room,
  RoomEvent,
  Track,
  ConnectionState,
  DisconnectReason,
} from '/vendor/livekit-client.esm.mjs';
import { createEvaluationPanel } from './evaluation.js';
import { createCoachPanel } from './coach.js';
import { createFeedbackPanel } from './feedback.js';
import { createTranscriber } from './stt.js';
import { createStreamFilter } from './stream-filter.js';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const $ = (id) => document.getElementById(id);
const [, , sessionId, myRole] = location.pathname.split('/');
const joinKey = new URLSearchParams(location.search).get('key') || '';
const otherRole = myRole === 'interviewer' ? 'candidate' : 'interviewer';
const ROLE_LABEL = { interviewer: 'Interviewer', candidate: 'Candidate' };
const isHost = myRole === 'interviewer';
const isElectron = typeof window.appBridge !== 'undefined';

const state = {
  join: null, // response of POST /api/interviews/:id/join
  room: null,
  ws: null,
  wsRetry: 0,
  wsTimer: null,
  heartbeat: null,
  lastServerMessage: 0, // any server message proves the socket is alive
  interview: null, // latest server snapshot
  snapshotAt: 0, // performance.now() when the snapshot arrived
  pinned: null, // role pinned to the main stage
  speaking: new Set(),
  leaving: false,
  chatPending: false,
  chatSeen: new Set(),
  unreadChat: 0,
  transcription: 'unavailable', // 'segments' | 'stream' | 'unavailable'
  sttState: 'idle', // our own transcription state
  peerStt: null, // interviewer view: the candidate's transcription state
  speakingNow: {},
  tab: null, // open side-panel tab, or null when closed
  transcriptSeen: new Set(),
  screenSharing: false, // candidate is sharing their screen
  shareSurface: 'unknown', // 'browser' (tab), 'window', 'monitor' (entire screen)
  coachPaused: false, // server-side coaching pause while the share surface would expose it
  streamFilter: null, // canvas-based stream processor (removes coaching from outgoing frames)
  rawScreenTrack: null, // original getDisplayMedia video track
};

// Interviewer-only AI evaluation module (the server never sends evaluation data to candidates).
let evalPanel = null;
let coachPanel = null;
let feedbackPanel = null;

// Both roles: our own microphone → server speech-to-text (speaker set server-side).
const transcriber = createTranscriber({
  sendJSON: (msg) => sendWS(msg),
  // Binary PCM frames; skipped (not queued) if the socket is congested.
  sendBinary: (buf, maxBuffered) => {
    const ws = state.ws;
    if (ws?.readyState === WebSocket.OPEN && ws.bufferedAmount < maxBuffered) ws.send(buf);
  },
  getMicTrack: () => {
    const pub = state.room?.localParticipant?.getTrackPublication(Track.Source.Microphone);
    return pub && !pub.isMuted && pub.track ? pub.track.mediaStreamTrack : null;
  },
  onState: (s) => renderTranscriptionState(s),
});

// ---------------------------------------------------------------------------
// Small UI helpers
// ---------------------------------------------------------------------------

/** Toast with an optional recovery action. */
function toast(text, kind = '', action = null) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.append(text);
  if (action) {
    const btn = document.createElement('button');
    btn.className = 'toast-action';
    btn.textContent = action.label;
    btn.addEventListener('click', () => { el.remove(); action.run(); });
    el.append(btn);
  }
  $('toasts').appendChild(el);
  setTimeout(() => el.remove(), action ? 9000 : kind === 'error' ? 6000 : kind === 'warn' ? 8000 : 3500);
}

function initials(name) {
  return (name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
}

function nameOf(role) {
  return state.interview?.participants?.[role]?.name || ROLE_LABEL[role];
}

function fmt(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function mediaError(kind, err) {
  const name = err?.name || '';
  const device = kind === 'mic' ? 'microphone' : 'camera';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return kind === 'screen'
      ? 'Screen sharing was cancelled or blocked by the browser.'
      : `${kind === 'mic' ? 'Microphone' : 'Camera'} unavailable: permission denied. Allow it in the browser's site settings (lock icon in the address bar).`;
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') return `No ${device} was found. Connect one and try again.`;
  if (name === 'NotReadableError') return `Your ${device} is being used by another application. Close it and try again.`;
  return `Could not change ${kind === 'screen' ? 'screen sharing' : `the ${device}`}.`;
}

function actionButton(label, run, primary = false) {
  const el = document.createElement(typeof run === 'string' ? 'a' : 'button');
  el.className = primary ? 'btn-primary' : 'btn-secondary';
  el.textContent = label;
  if (typeof run === 'string') el.href = run; else el.addEventListener('click', run);
  return el;
}

// ---------------------------------------------------------------------------
// Lobby: validate the link and join
// ---------------------------------------------------------------------------

async function requestJoin() {
  const resp = await fetch(`/api/interviews/${encodeURIComponent(sessionId)}/join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(isHost ? { role: myRole } : { role: myRole, key: joinKey }),
  });
  const body = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const err = new Error(body.error || `Request failed (${resp.status})`);
    err.code = body.code;
    throw err;
  }
  return body;
}

/** Explains why joining isn't possible and offers the right next step. */
function lobbyProblem(err) {
  const actions = [];
  let title = "Can't join this interview";
  if (err.code === 'unauthenticated') {
    title = 'Sign in to continue';
    actions.push(actionButton('Sign in', `/login?next=${encodeURIComponent(location.pathname)}`, true));
  } else if (err.code === 'ended') {
    title = err.message.includes('cancelled') ? 'Interview cancelled' : 'Interview already completed';
    if (isHost) actions.push(actionButton('View report', `/interview/${sessionId}/report`, true), actionButton('All interviews', '/dashboard'));
  } else if (err.code === 'forbidden' || err.code === 'unauthorized') {
    if (isHost) actions.push(actionButton('Go to your interviews', '/dashboard', true));
  } else if (err.code === 'invalid_session') {
    title = 'Interview not found or expired';
    if (isHost) actions.push(actionButton('Go to your interviews', '/dashboard', true));
  } else {
    actions.push(actionButton('Try again', () => location.reload(), true));
  }
  $('lobbyTitle').textContent = title;
  $('lobbySub').textContent = err.message === 'Failed to fetch' ? 'Could not reach the interview server. Check your connection.' : err.message;
  $('joinBtn').hidden = true;
  $('lobbyActions').replaceChildren(...actions);
  $('lobbyActions').hidden = !actions.length;
}

async function prepareLobby() {
  if (myRole !== 'interviewer' && myRole !== 'candidate') {
    lobbyProblem({ message: 'This interview link is not valid.', code: 'invalid' });
    return;
  }
  try {
    state.join = await requestJoin();
    applySnapshot(state.join.interview);
    const other = nameOf(otherRole);
    $('lobbyTitle').textContent = `Ready to join, ${state.join.name}?`;
    $('lobbySub').textContent = `${state.join.interview.position} · ${ROLE_LABEL[myRole]} · ${
      state.join.interview.participants[otherRole].connected ? `${other} is here` : `${other} hasn't joined yet`}`;
    $('lobbyPrefs').hidden = false;
    $('joinBtn').disabled = false;
  } catch (err) {
    lobbyProblem(err);
  }
}

async function enterRoom() {
  $('joinBtn').disabled = true;
  $('joinBtn').textContent = 'Joining interview…';
  $('lobbyError').textContent = '';
  state.leaving = false;

  try {
    // A fresh token each time (the lobby token may be old after a rejoin).
    state.join = await requestJoin();
    applySnapshot(state.join.interview);
    buildFilmstrip();
    showView('room');
    setConnection('Connecting…');
    connectWS();
    await connectLiveKit($('prefMic').checked, $('prefCam').checked);
  } catch (err) {
    console.error('Join failed:', err);
    teardown();
    showView('lobby');
    if (err.code) lobbyProblem(err);
    else $('lobbyError').textContent = err.message === 'Failed to fetch' ? 'Could not reach the interview server. Try again.' : `Unable to join: ${err.message}`;
  } finally {
    $('joinBtn').disabled = false;
    $('joinBtn').textContent = 'Join interview';
  }
}

function showView(view) {
  $('lobby').hidden = view !== 'lobby';
  $('room').hidden = view !== 'room';
  $('ended').hidden = view !== 'ended';
}

// ---------------------------------------------------------------------------
// LiveKit
// ---------------------------------------------------------------------------

async function connectLiveKit(micOn, camOn) {
  const room = new Room({ adaptiveStream: true, dynacast: true });
  state.room = room;

  room
    .on(RoomEvent.ConnectionStateChanged, (s) => {
      if (s === ConnectionState.Connected) setConnection('Connected');
      if (s === ConnectionState.Connecting) setConnection('Connecting…');
    })
    .on(RoomEvent.Reconnecting, () => {
      setConnection('Reconnecting…', 'warn');
      toast('Connection lost. Reconnecting…');
    })
    .on(RoomEvent.Reconnected, () => {
      setConnection('Connected');
      toast('Reconnected');
    })
    .on(RoomEvent.Disconnected, (reason) => onRoomDisconnected(reason))
    .on(RoomEvent.ParticipantConnected, (p) => {
      toast(`${p.name || 'A participant'} joined`);
      render();
    })
    .on(RoomEvent.ParticipantDisconnected, (p) => {
      toast(`${p.name || 'A participant'} left`);
      if (state.pinned === otherRole) state.pinned = null;
      render();
    })
    .on(RoomEvent.TrackSubscribed, (track) => {
      if (track.kind === Track.Kind.Audio) $('audioSink').appendChild(track.attach());
      render();
    })
    .on(RoomEvent.TrackUnsubscribed, (track) => {
      if (track.kind === Track.Kind.Audio) track.detach().forEach((el) => el.remove());
      render();
    })
    .on(RoomEvent.TrackPublished, (pub, p) => {
      if (pub.source === Track.Source.ScreenShare) toast(`${p.name} started presenting`);
      render();
    })
    .on(RoomEvent.TrackUnpublished, (pub, p) => {
      if (pub.source === Track.Source.ScreenShare) toast(`${p.name} stopped presenting`);
      render();
    })
    .on(RoomEvent.TrackMuted, (pub, p) => {
      if (p !== room.localParticipant) {
        if (pub.source === Track.Source.Camera) toast(`${p.name} turned off their camera`);
        if (pub.source === Track.Source.Microphone) toast(`${p.name} muted their microphone`);
      }
      render();
    })
    .on(RoomEvent.TrackUnmuted, (pub, p) => {
      if (p !== room.localParticipant) {
        if (pub.source === Track.Source.Camera) toast(`${p.name} turned on their camera`);
        if (pub.source === Track.Source.Microphone) toast(`${p.name} unmuted their microphone`);
      }
      render();
    })
    // The browser's own "Stop sharing" bar unpublishes the screen track too.
    .on(RoomEvent.LocalTrackPublished, (pub) => {
      if (pub.source === Track.Source.ScreenShare) {
        if (!state.streamFilter) detectShareSurface(room.localParticipant);
        applyScreenShareHide(true);
        applyShareSurfacePolicy();
      }
      render(); reportMedia();
    })
    .on(RoomEvent.LocalTrackUnpublished, (pub) => {
      if (pub.source === Track.Source.ScreenShare) {
        state.shareSurface = 'unknown';
        applyScreenShareHide(false);
      }
      render(); reportMedia();
    })
    .on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
      state.speaking = new Set(speakers.map((s) => s.identity));
      renderSpeaking();
    })
    .on(RoomEvent.AudioPlaybackStatusChanged, () => {
      $('audioUnlock').hidden = room.canPlaybackAudio;
    });

  try {
    await room.connect(state.join.livekit.url, state.join.livekit.token);
  } catch {
    throw new Error('Could not connect to the video service. Check your network and try again.');
  }
  $('audioUnlock').hidden = room.canPlaybackAudio;

  // Devices are optional: a denied or missing device must not block joining.
  if (micOn) await setMic(true);
  if (camOn) await setCam(true);
  render();
  reportMedia();
}

function onRoomDisconnected(reason) {
  if (state.leaving) return;
  setConnection('Disconnected', 'bad');
  if (reason === DisconnectReason.DUPLICATE_IDENTITY) {
    endView('You joined from another tab', 'This window was disconnected because you joined the interview elsewhere.');
  } else if (reason === DisconnectReason.ROOM_DELETED || reason === DisconnectReason.PARTICIPANT_REMOVED) {
    endView('You were removed from the interview', '');
  } else {
    endView('Connection lost', 'The connection to the interview was lost. Your place is kept — rejoin to continue.');
  }
  teardown();
}

async function setMic(on) {
  const lp = state.room?.localParticipant;
  if (!lp) return;
  try {
    await lp.setMicrophoneEnabled(on);
  } catch (err) {
    toast(mediaError('mic', err), 'error', { label: 'Try again', run: () => setMic(true) });
  }
  render();
  reportMedia();
}

async function setCam(on) {
  const lp = state.room?.localParticipant;
  if (!lp) return;
  try {
    await lp.setCameraEnabled(on);
  } catch (err) {
    toast(mediaError('camera', err), 'error', { label: 'Try again', run: () => setCam(true) });
  }
  render();
  reportMedia();
}

async function setShare(on, { preferCurrentTab = false } = {}) {
  const lp = state.room?.localParticipant;
  if (!lp) return;
  if (on && presenter() && presenter() !== lp) {
    toast(`${presenter().name} is already presenting.`);
    return;
  }

  if (!on) {
    // Stop sharing — clean up filtered stream if active
    if (state.streamFilter) {
      state.streamFilter.stop();
      state.streamFilter = null;
    }
    if (state.rawScreenTrack) {
      state.rawScreenTrack = null;
    }
    try {
      await lp.setScreenShareEnabled(false);
    } catch {}
    render();
    reportMedia();
    return;
  }

  // Candidate with coaching: hide coaching from the shared page.
  // Electron: coaching moves to an OS-level content-protected window.
  // Browser: coaching moves to a separate popup window (invisible to tab/window share).
  // In both cases, normal LiveKit screen share is used — no canvas filter needed.
  if (!isHost && coachPanel?.enabled) {
    applyScreenShareHide(true);
    try {
      await lp.setScreenShareEnabled(on, {
        audio: true,
        selfBrowserSurface: 'include',
        preferCurrentTab,
      });
    } catch (err) {
      applyScreenShareHide(false);
      if (err.name !== 'NotAllowedError') {
        toast(mediaError('screen', err), 'error', { label: 'Try again', run: () => setShare(true) });
      }
    }
    render();
    reportMedia();
    return;
  }

  // Default: normal LiveKit screen share (interviewer or coaching disabled)
  try {
    await lp.setScreenShareEnabled(on, {
      audio: true,
      selfBrowserSurface: 'exclude',
      preferCurrentTab: true,
    });
    if (on) detectShareSurface(lp);
  } catch (err) {
    toast(mediaError('screen', err), 'error', { label: 'Try again', run: () => setShare(true) });
  }
  render();
  reportMedia();
}

function detectShareSurface(lp) {
  state.shareSurface = 'unknown';
  try {
    for (const pub of lp.trackPublications.values()) {
      if (pub.source === Track.Source.ScreenShare && pub.track?.mediaStreamTrack) {
        const settings = pub.track.mediaStreamTrack.getSettings();
        state.shareSurface = settings.displaySurface || 'unknown';
        break;
      }
    }
  } catch {}
}

function localMedia() {
  const lp = state.room?.localParticipant;
  return {
    mic: !!lp?.isMicrophoneEnabled,
    camera: !!lp?.isCameraEnabled,
    screen: !!lp?.isScreenShareEnabled,
  };
}

// ---------------------------------------------------------------------------
// Video rendering
// ---------------------------------------------------------------------------

const tiles = {};

function buildFilmstrip() {
  const strip = $('filmstrip');
  strip.innerHTML = '';
  for (const role of ['candidate', 'interviewer']) {
    const el = document.createElement('div');
    el.className = 'tile';
    el.tabIndex = 0;
    el.setAttribute('role', 'button');
    el.innerHTML = `
      <video autoplay playsinline muted hidden></video>
      <div class="placeholder"><div class="avatar"></div></div>
      <span class="tile-role"></span>
      <span class="mic-off" hidden aria-label="Microphone off"><svg viewBox="0 0 24 24"><path d="M19 11h-2c0 .7-.2 1.4-.4 2l1.5 1.5c.6-1 .9-2.2.9-3.5zm-4 .2V5a3 3 0 0 0-5.9-.8L15 10.1v1.1zM4.3 3 3 4.3l6 6V11a3 3 0 0 0 4.3 2.7l1.6 1.6A5 5 0 0 1 7 11H5a7 7 0 0 0 6 6.9V21h2v-3.1c1-.1 1.9-.5 2.7-1l4 4 1.3-1.3z"/></svg></span>
      <span class="tile-label"></span>`;
    const pin = () => {
      if (!participantFor(role)) return;
      state.pinned = state.pinned === role ? null : role;
      render();
    };
    el.addEventListener('click', pin);
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pin(); } });
    strip.appendChild(el);
    tiles[role] = {
      el,
      video: el.querySelector('video'),
      avatar: el.querySelector('.avatar'),
      placeholder: el.querySelector('.placeholder'),
      micOff: el.querySelector('.mic-off'),
      label: el.querySelector('.tile-label'),
      roleTag: el.querySelector('.tile-role'),
    };
  }
}

function participantFor(role) {
  const room = state.room;
  if (!room) return null;
  if (role === myRole) return room.localParticipant;
  for (const p of room.remoteParticipants.values()) {
    if (p.identity.startsWith(`${role}_`)) return p;
  }
  return null;
}

function trackOf(p, source) {
  const pub = p?.getTrackPublication(source);
  if (!pub || pub.isMuted || !pub.track) return null;
  return pub.track.mediaStreamTrack;
}

function presenter() {
  for (const role of ['candidate', 'interviewer']) {
    const p = participantFor(role);
    if (trackOf(p, Track.Source.ScreenShare)) return p;
  }
  return null;
}

function setVideo(video, track, { mirror = false, contain = false } = {}) {
  const current = video.srcObject?.getVideoTracks?.()[0] ?? null;
  if (current !== track) video.srcObject = track ? new MediaStream([track]) : null;
  video.hidden = !track;
  video.classList.toggle('mirror', mirror);
  video.classList.toggle('contain', contain);
}

function render() {
  if (!state.room) return;

  for (const role of ['candidate', 'interviewer']) {
    const t = tiles[role];
    if (!t) continue;
    const p = participantFor(role);
    const isMe = role === myRole;
    const cam = trackOf(p, Track.Source.Camera);
    setVideo(t.video, cam, { mirror: isMe });
    t.placeholder.hidden = !!cam;
    t.avatar.textContent = initials(nameOf(role));
    t.label.textContent = `${nameOf(role)}${isMe ? ' (You)' : ''}${p ? '' : ' · not joined'}`;
    t.roleTag.textContent = ROLE_LABEL[role];
    t.micOff.hidden = !p || p.isMicrophoneEnabled;
    t.el.classList.toggle('absent', !p);
    t.el.classList.toggle('pinned', state.pinned === role);
    t.el.setAttribute('aria-label', `${nameOf(role)}${isMe ? ' (you)' : ''}. ${state.pinned === role ? 'Unpin' : 'Pin'} to main view`);
  }

  // Main stage: a screen share wins, then the pinned person, then the other participant.
  const shareBy = presenter();
  const mainVideo = $('mainVideo');
  const presentNotice = $('presentNotice');
  if (shareBy) {
    const me = shareBy === state.room.localParticipant;
    // Like Google Meet, the presenter never previews their own share: rendering
    // it here while sharing this screen/window would capture itself endlessly.
    setVideo(mainVideo, me ? null : trackOf(shareBy, Track.Source.ScreenShare), { contain: true });
    $('mainPlaceholder').hidden = true;
    presentNotice.hidden = !me;
    if (me) renderPresentNotice();
    $('mainLabel').textContent = me ? '' : `${shareBy.name} is presenting`;
  } else {
    presentNotice.hidden = true;
    const role = state.pinned || otherRole;
    const p = participantFor(role);
    const cam = trackOf(p, Track.Source.Camera);
    setVideo(mainVideo, cam, { mirror: role === myRole });
    $('mainPlaceholder').hidden = !!cam;
    $('mainAvatar').textContent = initials(nameOf(role));
    $('mainPlaceholderText').textContent = p
      ? `${nameOf(role)}${role === myRole ? ' (You)' : ''} · camera off`
      : `Waiting for ${nameOf(role)} to join…`;
    $('mainLabel').textContent = cam ? `${nameOf(role)}${role === myRole ? ' (You)' : ''}` : '';
  }

  renderSpeaking();
  renderControls();
  transcriber.sync(); // our mic track may have changed (mute, device switch)
}

function renderSpeaking() {
  for (const role of ['candidate', 'interviewer']) {
    const p = participantFor(role);
    tiles[role]?.el.classList.toggle('speaking', !!p && state.speaking.has(p.identity));
  }
}

function setToggle(btn, on, onLabel, offLabel, shortcut) {
  btn.setAttribute('aria-pressed', String(on));
  const label = on ? onLabel : offLabel;
  btn.setAttribute('aria-label', label);
  btn.dataset.tip = shortcut ? `${label} (${shortcut})` : label;
}

function renderControls() {
  const m = localMedia();
  const inRoom = !!state.room;
  setToggle($('micBtn'), m.mic, 'Turn off microphone', 'Turn on microphone', 'Ctrl+D');
  setToggle($('camBtn'), m.camera, 'Turn off camera', 'Turn on camera', 'Ctrl+E');
  setToggle($('shareBtn'), m.screen, 'Stop presenting', 'Present your screen');
  for (const id of ['micBtn', 'camBtn']) $(id).disabled = !inRoom;

  const shareAllowed = isHost || state.interview?.allowCandidateScreenShare !== false;
  $('shareBtn').disabled = !inRoom || !shareAllowed;
  if (!shareAllowed) $('shareBtn').dataset.tip = 'Screen sharing is disabled for this interview';

  const status = state.interview?.status;
  const wsReady = state.ws?.readyState === WebSocket.OPEN;
  $('hostControls').hidden = !isHost;
  $('startBtn').hidden = status !== 'WAITING' && status !== 'CREATED';
  $('resumeBtn').hidden = status !== 'PAUSED';
  $('endBtn').hidden = !['WAITING', 'LIVE', 'PAUSED'].includes(status);
  $('endBtn').textContent = status === 'WAITING' ? 'Cancel interview' : 'End interview';
  for (const id of ['startBtn', 'resumeBtn', 'endBtn']) {
    $(id).disabled = !wsReady;
    if (!wsReady) $(id).dataset.tip = 'Reconnecting to the interview server…';
    else delete $(id).dataset.tip;
  }
  $('startBtn').dataset.tip = wsReady ? 'Starts the timer for both participants' : 'Reconnecting to the interview server…';
  if (isHost) { // host-only menu items are removed from the DOM for candidates
    $('menuPause').hidden = status !== 'LIVE';
    $('menuResume').hidden = status !== 'PAUSED';
    $('menuPause').disabled = $('menuResume').disabled = !wsReady;
  }
}

// ---------------------------------------------------------------------------
// Side panel (tabs) and More menu
// ---------------------------------------------------------------------------

const TABS = isHost ? ['eval', 'questions', 'transcript', 'chat'] : ['transcript', 'chat'];

/**
 * Reveals a tab and wires its click once. Tabs can appear after load (the coach
 * tab only exists once the server confirms coaching is on), so attaching the
 * listener here rather than in a one-shot loop is what makes a late tab usable.
 */
const wiredTabs = new Set();
function enableTab(t) {
  const el = $(`tab-${t}`);
  if (!el) return;
  el.hidden = false;
  if (wiredTabs.has(t)) return;
  wiredTabs.add(t);
  el.addEventListener('click', () => openTab(t));
}

/**
 * Coaching is never silent: the candidate gets the panel, and the interviewer
 * gets a badge saying it is on. Neither side can turn the disclosure off.
 */
function applyCoachingDisclosure(enabled) {
  if (!enabled) return;
  if (isHost) return;
  if (!TABS.includes('coach')) TABS.unshift('coach');
  enableTab('coach');
  const menuCoach = $('menuCoach');
  if (menuCoach) menuCoach.hidden = false;
  coachPanel?.render();
  if (state.screenSharing) applyScreenShareHide(true);
}

// ---------------------------------------------------------------------------
// Screen-share-safe coaching popup
// ---------------------------------------------------------------------------
// When the candidate shares their screen the AI Coach and Answer Feedback tabs
// hide from the main tab (which IS the shared surface) and move to a separate
// popup window the interviewer cannot see.  The popup receives live coaching
// and feedback data via BroadcastChannel and closes when screen sharing stops.

const SS_HIDDEN_TABS = ['coach', 'feedback'];
let popupWin = null;
let popupChannel = null;
let popupBlocked = false;

function initPopupChannel() {
  if (popupChannel) return;
  popupChannel = new BroadcastChannel('coach-popup');
  popupChannel.onmessage = (e) => {
    const d = e.data;
    if (d?.type === 'popup_ready') {
      popupChannel.postMessage({
        type: 'init',
        coach: coachPanel?.getState() ?? null,
        feedback: feedbackPanel?.getState() ?? null,
      });
    }
    if (d?.type === 'popup_closed') {
      popupWin = null;
    }
  };
}

function openCoachPopup() {
  if (popupWin && !popupWin.closed) { popupWin.focus(); return true; }
  initPopupChannel();
  popupWin = window.open(
    '/room-assets/coach-popup.html',
    'coach-popup',
    'width=400,height=580,top=60,left=20,resizable=yes,scrollbars=yes'
  );
  if (!popupWin) {
    popupBlocked = true;
    return false;
  }
  popupBlocked = false;
  return true;
}

function closeCoachPopup() {
  if (popupChannel) {
    try { popupChannel.postMessage({ type: 'close' }); } catch {}
    popupChannel.close();
    popupChannel = null;
  }
  if (popupWin && !popupWin.closed) popupWin.close();
  popupWin = null;
  popupBlocked = false;
}

function relayToPopup(msg) {
  if (!popupChannel || !popupWin || popupWin.closed) return;
  try { popupChannel.postMessage({ type: 'relay', msg }); } catch {}
}

function renderPresentNotice() {
  const sub = $('presentNoticeSub');
  const tabBtn = $('presentTabBtn');
  if (state.coachPaused) {
    sub.textContent = "You're sharing your entire screen, so AI Coach is paused — it would be visible to the interviewer. Share this browser tab instead to keep coaching private.";
    sub.classList.add('warn');
    tabBtn.hidden = false;
  } else {
    sub.textContent = 'Others in the interview can see your screen.';
    sub.classList.remove('warn');
    tabBtn.hidden = true;
  }
}

/**
 * Runs once the browser tells us what the candidate picked in the share dialog.
 * Tab and window shares leave the popup window outside the capture, so coaching
 * stays private there. A whole-monitor share captures everything, including the
 * popup — the only honest option in a browser is to pause coaching until the
 * share ends or is switched to a tab.
 */
function applyShareSurfacePolicy() {
  if (isHost || !coachPanel?.enabled || isElectron) return;
  const monitor = state.shareSurface === 'monitor';
  setCoachPausedForShare(monitor);
}

function setCoachPausedForShare(paused) {
  if (state.coachPaused === paused) return;
  state.coachPaused = paused;
  sendWS({ type: 'coaching_visibility', hidden: paused, reason: paused ? 'monitor_share' : 'share_safe' });
  if (paused) {
    closeCoachPopup();
    showCoachFloat(false);
    toast('AI Coach paused while you share your entire screen', 'warn',
      { label: 'Share a tab instead', run: reshareAsTab });
  }
  renderPresentNotice();
}

async function reshareAsTab() {
  await setShare(false);
  await setShare(true, { preferCurrentTab: true });
}

function autoShowCoachPopup() {
  const surface = state.shareSurface || 'unknown';
  if (surface === 'monitor') {
    toast('AI Coach is paused while you share your entire screen', 'warn',
      { label: 'Share a tab instead', run: reshareAsTab });
    return;
  }
  if (surface === 'window') {
    openTab('coach');
    return;
  }
  if (isPopupLive()) { popupWin.focus(); return; }
  if (openCoachPopup()) {
    toast('AI Coach opened — hidden from your screen share');
    showPopupPlaceholder(true);
  } else if (!popupBlocked) {
    toast('Allow popups to see AI Coach during screen share', 'error',
      { label: 'Open now', run: () => { if (openCoachPopup()) { toast('Coaching window opened'); showPopupPlaceholder(true); } } });
  }
}

function isPopupLive() {
  return popupWin && !popupWin.closed;
}

function showPopupPlaceholder(show) {
  let el = $('coachPopupNotice');
  if (show && !el) {
    el = document.createElement('div');
    el.id = 'coachPopupNotice';
    el.className = 'popup-notice';
    el.innerHTML = '<div class="popup-notice-icon">&#x1f6e1;</div>'
      + '<p><strong>AI Coach is in a separate window</strong></p>'
      + '<p class="popup-notice-sub">Not visible to the interviewer through your screen share</p>'
      + '<button class="popup-notice-btn" id="popupFocusBtn">Focus popup window</button>';
    const body = $('coachBody');
    if (body) { body.textContent = ''; body.appendChild(el); }
    $('popupFocusBtn')?.addEventListener('click', () => {
      if (isPopupLive()) popupWin.focus();
      else if (openCoachPopup()) toast('Coaching window opened');
      else toast('Popup blocked — allow popups for this site', 'error');
    });
  } else if (!show && el) {
    el.remove();
    coachPanel?.render();
  }
}

function applyScreenShareHide(sharing) {
  state.screenSharing = sharing;
  if (isHost) return;

  if (sharing && coachPanel?.enabled) {
    // Hide coaching-related tabs from the side panel so they don't leak
    // into the screen share.
    $('tab-coach').hidden = true;
    $('tab-feedback').hidden = true;
    if (state.tab === 'coach' || state.tab === 'feedback') {
      openTab('transcript');
    }

    if (isElectron) {
      // Electron: coaching goes to the OS-level content-protected window
      sendCoachToElectron();
      window.appBridge.setCoachStatus(true, 'Coaching active');
      toast("AI Coach moved to protected overlay — invisible to screen capture");
    } else {
      // Browser: coaching goes to a separate popup window.
      // Tab/window sharing: popup is a different window, completely invisible.
      // Monitor sharing: popup is visible but on a separate window the
      // candidate can move to another monitor or minimize before sharing.
      if (openCoachPopup()) {
        showPopupPlaceholder(true);
        toast('AI Coach opened in a separate window — hidden from screen share');
      } else {
        showCoachFloat(true);
        renderCoachFloat();
        toast('Allow popups to see AI Coach during screen share', 'warn',
          { label: 'Open now', run: () => { if (openCoachPopup()) { showPopupPlaceholder(true); showCoachFloat(false); toast('Coaching window opened'); } } });
      }
    }
  } else if (!sharing) {
    // Restore coaching tabs in the side panel
    if (coachPanel?.enabled) {
      $('tab-coach').hidden = false;
      $('tab-feedback').hidden = !feedbackPanel;
    }

    if (isElectron) {
      window.appBridge.clearCoach();
      window.appBridge.setCoachStatus(false, 'Screen share ended');
    }
    closeCoachPopup();
    showPopupPlaceholder(false);
    showCoachFloat(false);
    setCoachPausedForShare(false);
    if (coachPanel?.enabled) toast('AI Coach restored to panel');
  }
}

// ---------------------------------------------------------------------------
// Floating coaching overlay (screen-share safe)
// ---------------------------------------------------------------------------
// During screen share the coaching content is shown in a fixed-position float.
// The stream-filter paints over this region in every outgoing video frame so
// the interviewer sees a clean stream while the candidate sees coaching live.

const COACH_SECTIONS = [
  ['HINTS', 'Key points'],
  ['STRUCTURE', 'Structure'],
  ['GROUNDING', 'Draw on'],
  ['CAUTION', 'Watch out'],
];

function showCoachFloat(show) {
  const el = $('coachFloat');
  if (!el) return;
  el.hidden = !show;
}

function renderCoachFloat() {
  const body = $('coachFloatBody');
  if (!body || $('coachFloat')?.hidden) return;

  const st = coachPanel?.getState();
  if (!st?.enabled || !st.history?.length) {
    body.innerHTML = "<p style=\"color:var(--muted);font-size:13px\">Waiting for interviewer's question…</p>";
    return;
  }

  const rec = st.history.find((r) => r.questionId === st.selectedId) || st.history[st.history.length - 1];
  if (!rec) return;

  let html = `<div class="coach-card"><div class="coach-q-label">Question</div><p class="coach-q">${esc(rec.question)}</p>`;
  if (rec.state === 'thinking' || rec.state === 'streaming') {
    html += `<div class="coach-status"><span class="spinner"></span> ${rec.state === 'thinking' ? 'Thinking…' : 'Writing hints…'}</div>`;
  } else if (rec.state === 'error') {
    html += '<div class="coach-status error">AI coaching temporarily unavailable</div>';
  }
  html += '</div>';

  for (const [key, label] of COACH_SECTIONS) {
    const text = rec.sections?.[key];
    if (!text) continue;
    const lines = text.split('\n').map((l) => l.replace(/^\s*[-•*]\s*/, '').trim()).filter(Boolean);
    if (!lines.length) continue;
    if (key === 'HINTS') {
      html += `<section class="coach-section"><h4>${esc(label)}</h4><ul class="coach-hints">${lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul></section>`;
    } else {
      html += `<section class="coach-section"><h4>${esc(label)}</h4><p class="coach-line">${esc(lines.join(' '))}</p></section>`;
    }
  }

  body.innerHTML = html;
}

function esc(s) {
  const d = document.createElement('div');
  d.textContent = s || '';
  return d.innerHTML;
}

function sendCoachToElectron() {
  if (!isElectron || !window.appBridge) return;
  const st = coachPanel?.getState();
  if (!st?.enabled || !st.history?.length) {
    window.appBridge.updateCoach('<div class="empty">Waiting for interviewer to ask a question.</div>');
    return;
  }
  const rec = st.history.find((r) => r.questionId === st.selectedId) || st.history[st.history.length - 1];
  if (!rec) return;

  let html = `<div class="coach-card"><div class="coach-q-label">Question</div><p class="coach-q">${esc(rec.question)}</p>`;
  if (rec.state === 'thinking' || rec.state === 'streaming') {
    html += `<div class="thinking"><div class="thinking-dots"><span></span><span></span><span></span></div> ${rec.state === 'thinking' ? 'Thinking…' : 'Writing hints…'}</div>`;
  } else if (rec.state === 'error') {
    html += '<p style="color:var(--caution);font-size:13px">AI coaching temporarily unavailable</p>';
  }
  html += '</div>';

  for (const [key, label] of COACH_SECTIONS) {
    const text = rec.sections?.[key];
    if (!text) continue;
    const lines = text.split('\n').map((l) => l.replace(/^\s*[-•*]\s*/, '').trim()).filter(Boolean);
    if (!lines.length) continue;
    const cls = key === 'CAUTION' ? ' caution' : key === 'GROUNDING' ? ' warning' : '';
    html += `<div class="coach-card"><div class="section-label${cls}">${esc(label)}</div>`;
    if (key === 'HINTS') {
      html += `<div class="section-body"><ul>${lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul></div>`;
    } else {
      html += `<div class="section-body">${esc(lines.join(' '))}</div>`;
    }
    html += '</div>';
  }

  window.appBridge.updateCoach(html);
}

$('coachFloatToggle')?.addEventListener('click', () => {
  $('coachFloat')?.classList.toggle('collapsed');
});

function openTab(tab) {
  state.tab = tab;
  $('sidePanel').hidden = false;
  for (const t of ['eval', 'questions', 'coach', 'feedback', 'transcript', 'chat']) {
    const selected = t === tab;
    $(`tab-${t}`).setAttribute('aria-selected', String(selected));
    $(`tab-${t}`).tabIndex = selected ? 0 : -1;
    $(`pane-${t}`).hidden = !selected;
  }
  $('chatBtn').setAttribute('aria-pressed', String(tab === 'chat'));
  $('chatBtn').setAttribute('aria-label', tab === 'chat' ? 'Close chat' : 'Open chat');
  if (tab === 'chat') {
    state.unreadChat = 0;
    renderChatBadges();
    $('chatInput').focus();
  }
  if (tab === 'eval') evalPanel?.clearUnseen();
  if (tab === 'coach') coachPanel?.clearUnseen();
  if (tab === 'feedback') feedbackPanel?.clearUnseen();
  if (tab === 'transcript') $('transcriptList').scrollTop = $('transcriptList').scrollHeight;
}

function closePanel() {
  state.tab = null;
  $('sidePanel').hidden = true;
  $('chatBtn').setAttribute('aria-pressed', 'false');
  $('chatBtn').setAttribute('aria-label', 'Open chat');
}

function toggleTab(tab) {
  if (state.tab === tab) closePanel(); else openTab(tab);
}

function renderChatBadges() {
  const n = state.unreadChat;
  for (const id of ['chatBadge', 'ctrlBadge']) {
    $(id).textContent = String(n);
    $(id).hidden = !n;
  }
}

function setMenu(open) {
  $('moreMenu').hidden = !open;
  $('moreBtn').setAttribute('aria-expanded', String(open));
  if (open) $('moreMenu').querySelector('button:not([hidden]):not(:disabled)')?.focus();
}

async function onMenu(action) {
  setMenu(false);
  switch (action) {
    case 'eval':
    case 'questions':
    case 'coach':
    case 'feedback':
    case 'transcript':
      openTab(action);
      break;
    case 'pause':
      sendWS({ type: 'interview_pause' });
      break;
    case 'resume':
      sendWS({ type: 'interview_resume' });
      break;
    case 'copy':
      try {
        await navigator.clipboard.writeText(state.join.candidateUrl);
        toast('Candidate link copied');
      } catch {
        prompt('Candidate link', state.join.candidateUrl);
      }
      break;
    case 'shortcuts':
      $('shortcutsDialog').showModal();
      break;
  }
}

// ---------------------------------------------------------------------------
// Transcript tab (both roles: shared conversation text only)
// ---------------------------------------------------------------------------

const segEls = new Map(); // segmentId → element (partials become finals in place)

function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/** Adds or updates one utterance. Partials show LIVE; the final replaces them (no duplicates). */
function upsertSegment(seg, isFinal) {
  const id = seg.segmentId || seg.id;
  if (isFinal && state.transcriptSeen.has(id)) return;
  const list = $('transcriptList');
  const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
  let el = id ? segEls.get(id) : null;
  if (!el) {
    el = document.createElement('div');
    el.innerHTML = '<div class="who"><span class="name"></span><time></time><span class="badge-live"></span></div><p></p><div class="seg-actions"></div>';
    list.appendChild(el);
    if (id) segEls.set(id, el);
  }
  $('transcriptEmpty').hidden = true;
  el.className = `seg ${seg.speaker}${isFinal ? '' : ' partial'}`;
  el.querySelector('.name').textContent = `${seg.speaker === myRole ? 'You' : nameOf(seg.speaker)} · ${ROLE_LABEL[seg.speaker]}`;
  el.querySelector('time').textContent = fmtTime(seg.timestamp || Date.now());
  const badge = el.querySelector('.badge-live');
  badge.textContent = isFinal ? (seg.lowConfidence ? '⚠ low confidence' : '') : 'LIVE';
  badge.className = `badge-live${isFinal ? (seg.lowConfidence ? ' low' : ' final') : ''}`;
  badge.title = seg.lowConfidence ? 'The speech recognizer was unsure about this segment' : '';
  el.querySelector('p').textContent = seg.text === '…' ? 'speaking…' : seg.text;

  const actions = el.querySelector('.seg-actions');
  actions.replaceChildren();
  // Interviewer: turn their own spoken question into the current question (never automatic).
  if (isFinal && isHost && seg.speaker === 'interviewer' && seg.text.split(/\s+/).length >= 3) {
    const use = document.createElement('button');
    use.type = 'button';
    use.className = 'linklike';
    use.textContent = 'Use as question';
    use.disabled = state.interview?.status !== 'LIVE';
    use.addEventListener('click', () => {
      if (sendWS({ type: 'question_start', questionText: seg.text })) {
        use.textContent = 'Question started';
        use.disabled = true;
      }
    });
    actions.append(use);
  }

  if (isFinal && id) {
    state.transcriptSeen.add(id);
    segEls.delete(id);
  }
  // Keep the DOM bounded in long interviews.
  const all = list.querySelectorAll('.seg:not(.partial)');
  if (all.length > 400) all[0].remove();
  if (nearBottom) list.scrollTop = list.scrollHeight;
}

/** "Candidate speaking…" in the transcript header (from the server's voice detection). */
function setSpeaking(speaker, speaking) {
  state.speakingNow[speaker] = speaking;
  const who = Object.entries(state.speakingNow).filter(([, v]) => v).map(([k]) => (k === myRole ? 'You' : nameOf(k)));
  $('speakingNow').textContent = who.length ? `${who.join(' and ')} speaking…` : '';
}

const STT_LABEL = {
  idle: '',
  initializing: 'Initializing microphone…',
  capturing: 'Connecting to transcription…',
  connecting: 'Connecting to transcription…',
  transcribing: '● Transcribing',
  reconnecting: 'Transcription reconnecting…',
  unavailable: '⚠ Live transcription unavailable — Retry',
  stopped: 'Transcription stopped',
  mic_off: 'Mic off — not transcribing',
  blocked: 'Click anywhere to enable transcription',
  error: '⚠ Transcription unavailable in this browser',
};

/** Our own transcription state (local capture + server stream). */
function renderTranscriptionState(s) {
  state.sttState = s;
  const chip = $('transcribeChip');
  chip.hidden = s === 'idle';
  chip.textContent = STT_LABEL[s] ?? s;
  chip.dataset.state = s;
  chip.classList.toggle('warn', ['unavailable', 'reconnecting', 'error', 'blocked', 'mic_off'].includes(s));
  chip.disabled = s !== 'unavailable';
  chip.title = s === 'unavailable' ? 'Retry transcription' : 'Speech-to-text status for your microphone';
  renderSttHeader();
}

function renderSttHeader() {
  const own = STT_LABEL[state.sttState] || '';
  const peer = isHost && state.peerStt ? `Candidate: ${(STT_LABEL[state.peerStt] || state.peerStt).replace(' — Retry', '')}` : '';
  $('sttStatus').textContent = [own && `You: ${own.replace(' — Retry', '')}`, peer].filter(Boolean).join(' · ');
}

// ---------------------------------------------------------------------------
// Interview state & timer (server-authoritative)
// ---------------------------------------------------------------------------

function applySnapshot(snapshot) {
  const prev = state.interview?.status;
  state.interview = snapshot;
  state.snapshotAt = performance.now();
  $('positionLabel').textContent = snapshot.position;
  document.title = `${snapshot.position} · AI Interview`;

  if (prev && prev !== snapshot.status) {
    const msg = {
      LIVE: prev === 'PAUSED' ? 'Interview resumed' : 'Interview started',
      PAUSED: 'Interview paused',
      COMPLETED: 'Interview completed',
      CANCELLED: 'Interview cancelled',
    }[snapshot.status];
    if (msg) toast(msg);
  }
  if ((snapshot.status === 'COMPLETED' || snapshot.status === 'CANCELLED') && !$('room').hidden) {
    finishInterview(snapshot.status);
    return;
  }
  renderStatus();
  renderControls();
  syncLiveState();
  tick();
}

/** Transcription runs only while the interview is LIVE and the socket is open. */
function syncLiveState() {
  const live = state.interview?.status === 'LIVE';
  transcriber.setActive(live && state.ws?.readyState === WebSocket.OPEN);
  evalPanel?.setActive(live);
}

function remainingMs() {
  const iv = state.interview;
  if (!iv) return 0;
  const drift = iv.status === 'LIVE' ? performance.now() - state.snapshotAt : 0;
  return iv.remainingMs - drift;
}

function tick() {
  const iv = state.interview;
  if (!iv) return;
  const ms = remainingMs();
  $('timer').textContent = fmt(ms);
  $('timer').classList.toggle('low', iv.status === 'LIVE' && ms < 5 * 60_000);
  $('timerHint').textContent = iv.status === 'LIVE' || iv.status === 'PAUSED' ? 'remaining' : 'duration';
  $('clock').textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
setInterval(tick, 500);

function renderStatus() {
  const pill = $('statusPill');
  const iv = state.interview;
  let text = 'Connecting…';
  let cls = '';
  if (state.ws?.readyState !== WebSocket.OPEN && state.join) {
    text = state.wsRetry ? 'Reconnecting…' : 'Connecting…';
    cls = 'warn';
  } else if (iv) {
    const otherHere = iv.participants?.[otherRole]?.connected;
    switch (iv.status) {
      case 'CREATED':
      case 'WAITING':
        if (!otherHere) text = `Waiting for ${otherRole}…`;
        else text = isHost ? 'Candidate is here — ready to start' : 'Waiting for the interviewer to start…';
        break;
      case 'LIVE': text = 'Interview started'; cls = 'live'; break;
      case 'PAUSED': text = 'Interview paused'; cls = 'paused'; break;
      case 'COMPLETED': text = 'Interview completed'; break;
      case 'CANCELLED': text = 'Interview cancelled'; cls = 'bad'; break;
    }
  }
  pill.textContent = text;
  pill.className = `pill ${cls}`;
}

function setConnection(text, kind = '') {
  $('connectionLabel').textContent = `Video: ${text}`;
  $('connectionLabel').style.color = kind === 'bad' ? '#ff8a8e' : kind === 'warn' ? 'var(--warning)' : '';
}

// ---------------------------------------------------------------------------
// WebSocket (interview state, presence, transcript, chat, evaluation)
// ---------------------------------------------------------------------------

function connectWS() {
  clearTimeout(state.wsTimer);
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}/?view=room`);
  state.ws = ws;

  ws.onopen = () => {
    state.wsRetry = 0;
    ws.send(JSON.stringify({ type: 'session_join', sessionId, participantKey: state.join.participantKey }));
    startHeartbeat();
    syncLiveState();
    if (isElectron) window.appBridge.setCoachStatus(true, 'Connected to interview');
  };

  ws.onmessage = (ev) => {
    state.lastServerMessage = Date.now();
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    onServerMessage(msg);
  };

  ws.onclose = () => {
    if (state.ws !== ws) return;
    stopHeartbeat();
    syncLiveState();
    if (state.leaving || !state.join) return;
    // Exponential backoff up to 10s; a rejoin resyncs state, timer and history.
    const delay = Math.min(10_000, 1000 * 2 ** state.wsRetry++);
    state.wsTimer = setTimeout(connectWS, delay);
    renderStatus();
    renderControls();
  };
  ws.onerror = () => ws.close();
}

// Liveness is judged by the time since the last server message rather than a
// short pong deadline: background tabs throttle timers and could otherwise
// close a healthy socket.
function startHeartbeat() {
  stopHeartbeat();
  state.lastServerMessage = Date.now();
  state.heartbeat = setInterval(() => {
    if (state.ws?.readyState !== WebSocket.OPEN) return;
    if (Date.now() - state.lastServerMessage > 45_000) {
      state.ws.close();
      return;
    }
    state.ws.send(JSON.stringify({ type: 'ping' }));
  }, 15_000);
}

function stopHeartbeat() {
  clearInterval(state.heartbeat);
}

function sendWS(obj) {
  if (state.ws?.readyState !== WebSocket.OPEN) return false;
  state.ws.send(JSON.stringify(obj));
  return true;
}

function reportMedia() {
  sendWS({ type: 'participant_status', ...localMedia() });
}

function onServerMessage(msg) {
  // The shared transcript tab is updated for both roles.
  if (msg.type === 'transcript_final') upsertSegment(msg, true);
  else if (msg.type === 'transcript_partial') upsertSegment(msg, false);
  if (msg.type !== 'session_joined' && evalPanel?.onMessage(msg)) return;
  if (msg.type !== 'session_joined' && coachPanel?.onMessage(msg)) {
    if (state.coachPaused) {
      // Nothing may surface on-screen while a whole-monitor share is live.
    } else if (state.screenSharing && isElectron) {
      sendCoachToElectron();
    } else if (state.screenSharing) {
      // Relay to the popup window (primary) or floating overlay (fallback)
      relayToPopup(msg);
      if (!isPopupLive()) {
        renderCoachFloat();
        if (msg.type === 'coaching_question') {
          showCoachFloat(true);
          renderCoachFloat();
        }
      }
    } else if (msg.type === 'coaching_question') {
      if (isElectron) sendCoachToElectron();
      openTab('coach');
    }
    return;
  }
  if (msg.type !== 'session_joined' && feedbackPanel?.onMessage(msg)) {
    if (state.screenSharing) relayToPopup(msg);
    return;
  }

  switch (msg.type) {
    case 'session_joined':
      state.transcription = msg.transcription || 'unavailable';
      transcriber.setMode(state.transcription);
      (msg.transcript || []).forEach((seg) => upsertSegment(seg, true));
      evalPanel?.onJoined(msg);
      coachPanel?.onJoined(msg);
      applyCoachingDisclosure(msg.coachingEnabled === true);
      applySnapshot(msg.interview);
      loadChatHistory(msg.history || [], msg.pending);
      reportMedia();
      renderStatus();
      renderControls();
      break;
    case 'interview_state':
      applySnapshot(msg.interview);
      break;
    case 'transcription_state': {
      const own = msg.participantId === state.join?.identity;
      const prev = own ? state.sttState : state.peerStt;
      if (own) transcriber.onServerState(msg.state);
      else if (isHost) {
        state.peerStt = msg.state;
        renderSttHeader();
      }
      evalPanel?.setTranscriptionState(own ? 'self' : 'candidate', msg.state);
      if (msg.state === 'unavailable' && prev !== 'unavailable') {
        toast(own ? 'Live transcription unavailable — the interview continues.' : "Candidate's live transcription is unavailable.", 'error',
          own ? { label: 'Retry transcription', run: () => transcriber.retry() } : null);
      }
      break;
    }
    case 'speech_activity':
      setSpeaking(msg.speaker, msg.speaking);
      break;
    case 'pong':
      break; // liveness is tracked in ws.onmessage
    case 'error':
      if (msg.code === 'invalid_session') {
        teardown();
        endView("Can't rejoin this interview", msg.message);
      } else {
        toast(msg.message || 'Something went wrong.', 'error');
      }
      break;
    case 'chat_user_message':
      addChat(msg);
      break;
    case 'chat_response':
      addChat({ ...msg, sender: 'ai_interviewer' });
      break;
    case 'chat_pending':
      setChatPending(msg.pending);
      break;
    case 'chat_error':
      if (msg.sessionId || state.chatPending) {
        showChatError(msg.message || 'Unable to generate response');
        setChatPending(Boolean(msg.pending));
      }
      break;
  }
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

function loadChatHistory(history, pending) {
  $('chatMessages').querySelectorAll('.chat-msg').forEach((n) => n.remove());
  state.chatSeen.clear();
  history.forEach((m) => addChat(m, true));
  setChatPending(Boolean(pending));
}

function addChat(m, silent = false) {
  if (state.chatSeen.has(m.id)) return;
  state.chatSeen.add(m.id);
  $('chatEmpty').hidden = true;
  const el = document.createElement('div');
  el.className = 'chat-msg';
  const who = document.createElement('div');
  who.className = `who${m.sender === 'ai_interviewer' ? ' ai' : ''}`;
  who.textContent = m.sender === myRole ? 'You' : m.sender === 'ai_interviewer' ? 'AI Interviewer' : nameOf(m.sender);
  const time = document.createElement('time');
  time.textContent = new Date(m.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  who.appendChild(time);
  const text = document.createElement('p');
  text.textContent = m.message; // never render message HTML
  el.append(who, text);
  $('chatMessages').appendChild(el);
  $('chatMessages').scrollTop = $('chatMessages').scrollHeight;
  if (!silent && state.tab !== 'chat' && m.sender !== myRole) {
    state.unreadChat++;
    renderChatBadges();
  }
}

function setChatPending(p) {
  state.chatPending = p;
  $('chatThinking').classList.toggle('on', p);
  $('chatSend').disabled = p;
}

function showChatError(text) {
  $('chatError').textContent = text;
  $('chatError').classList.toggle('on', !!text);
}

function sendChat(e) {
  e?.preventDefault();
  const text = $('chatInput').value.trim();
  if (!text || state.chatPending) return;
  if (!sendWS({ type: 'chat_message', sessionId, sender: myRole, message: text })) {
    showChatError('Not connected to the interview server. Reconnecting…');
    return;
  }
  $('chatInput').value = '';
  showChatError('');
  setChatPending(true);
}

// ---------------------------------------------------------------------------
// Leaving / ending
// ---------------------------------------------------------------------------

function teardown() {
  state.leaving = true;
  stopHeartbeat();
  clearTimeout(state.wsTimer);
  transcriber.stop();
  closeCoachPopup();
  if (state.screenSharing) applyScreenShareHide(false);
  if (state.ws) { const ws = state.ws; state.ws = null; ws.close(); }
  if (state.room) { const room = state.room; state.room = null; room.disconnect().catch(() => {}); }
  $('audioSink').innerHTML = '';
  $('audioUnlock').hidden = true;
  setMenu(false);
}

function endView(title, sub, actions = null) {
  $('endedTitle').textContent = title;
  $('endedSub').textContent = sub;
  const list = actions ?? [
    actionButton('Rejoin', () => { showView('lobby'); enterRoom(); }, true),
    ...(isHost ? [actionButton('All interviews', '/dashboard')] : []),
  ];
  $('endedActions').replaceChildren(...list);
  showView('ended');
}

function leave() {
  teardown();
  endView('You left the interview', 'You can rejoin while the interview is still open.');
}

function finishInterview(status) {
  teardown();
  const cancelled = status === 'CANCELLED';
  if (isHost) {
    endView(
      cancelled ? 'Interview cancelled' : 'Interview completed',
      cancelled ? 'The interview was cancelled.' : 'Generating interview report… You can open it now; it updates when ready.',
      [actionButton('View report', `/interview/${sessionId}/report`, true), actionButton('All interviews', '/dashboard')]
    );
  } else {
    endView(
      cancelled ? 'Interview cancelled' : 'Interview completed',
      cancelled ? 'The interviewer cancelled this interview.' : 'Thank you for your time. The interview has ended.',
      []
    );
  }
}

async function confirmAction(title, text, okLabel) {
  $('confirmTitle').textContent = title;
  $('confirmText').textContent = text;
  $('confirmOk').textContent = okLabel;
  const dialog = $('confirmDialog');
  dialog.returnValue = '';
  dialog.showModal();
  return new Promise((resolve) => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'ok'), { once: true });
  });
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

$('joinBtn').addEventListener('click', enterRoom);
$('micBtn').addEventListener('click', () => setMic(!localMedia().mic));
$('camBtn').addEventListener('click', () => setCam(!localMedia().camera));
$('shareBtn').addEventListener('click', () => setShare(!localMedia().screen));
$('presentStopBtn').addEventListener('click', () => setShare(false));
$('presentTabBtn').addEventListener('click', reshareAsTab);
$('chatBtn').addEventListener('click', () => toggleTab('chat'));
$('sideClose').addEventListener('click', closePanel);
$('leaveBtn').addEventListener('click', leave);
$('chatForm').addEventListener('submit', sendChat);
$('chatInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) sendChat(e);
});
$('audioUnlock').addEventListener('click', () => state.room?.startAudio());
$('transcribeChip').addEventListener('click', () => {
  if (state.sttState === 'unavailable') transcriber.retry();
});
$('popoutBtn')?.addEventListener('click', () => {
  if (openCoachPopup()) toast('Coaching opened in a separate window');
  else toast('Popup blocked — allow popups for this site', 'error');
});

for (const t of TABS) enableTab(t);
// Arrow-key navigation between tabs (WAI-ARIA tabs pattern).
$('tabs').addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
  const visible = TABS;
  const i = visible.indexOf(state.tab);
  const next = visible[(i + (e.key === 'ArrowRight' ? 1 : visible.length - 1)) % visible.length];
  openTab(next);
  $(`tab-${next}`).focus();
});

document.querySelectorAll('#moreMenu .host-only').forEach((el) => { if (!isHost) el.remove(); });
// The coach entry appears only for a candidate, and only once coaching is confirmed on.
document.querySelectorAll('#moreMenu .coach-only').forEach((el) => { if (isHost) el.remove(); else el.hidden = true; });
$('moreBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  setMenu($('moreMenu').hidden);
});
$('moreMenu').addEventListener('click', (e) => {
  const item = e.target.closest('[data-menu]');
  if (item) onMenu(item.dataset.menu);
});
document.addEventListener('click', (e) => {
  if (!$('moreMenu').hidden && !e.target.closest('.more-wrap')) setMenu(false);
});

$('startBtn').addEventListener('click', () => sendWS({ type: 'interview_start' }));
$('resumeBtn').addEventListener('click', () => sendWS({ type: 'interview_resume' }));
$('endBtn').addEventListener('click', async () => {
  const waiting = state.interview?.status === 'WAITING';
  const ok = await confirmAction(
    waiting ? 'Cancel the interview?' : 'End the interview?',
    waiting
      ? 'The interview has not started. Cancelling closes it for everyone.'
      : 'This ends the interview for everyone, stops accepting answers and generates the report.',
    waiting ? 'Cancel interview' : 'End interview'
  );
  if (ok) sendWS({ type: waiting ? 'interview_cancel' : 'interview_end' });
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('moreMenu').hidden) {
    setMenu(false);
    $('moreBtn').focus();
    return;
  }
  if ($('room').hidden || !(e.ctrlKey || e.metaKey)) return;
  const key = e.key.toLowerCase();
  if (key === 'd') { e.preventDefault(); setMic(!localMedia().mic); }
  if (key === 'e') { e.preventDefault(); setCam(!localMedia().camera); }
});

// Returning to a background tab: reconnect now instead of waiting for a throttled timer.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || state.leaving || !state.join || $('room').hidden) return;
  const rs = state.ws?.readyState;
  if (rs !== WebSocket.OPEN && rs !== WebSocket.CONNECTING) connectWS();
});

window.addEventListener('beforeunload', () => {
  state.leaving = true;
  state.room?.disconnect();
});

if (isHost) {
  evalPanel = createEvaluationPanel({
    sendWS,
    toast,
    isVisible: () => state.tab === 'eval',
    setBadge: (n) => {
      $('evalBadge').textContent = String(n);
      $('evalBadge').hidden = !n;
    },
  });
  evalPanel.onShowEval(() => openTab('eval'));
} else {
  coachPanel = createCoachPanel({
    isVisible: () => state.tab === 'coach',
    setBadge: (n) => {
      $('coachBadge').textContent = String(n);
      $('coachBadge').hidden = !n;
    },
  });
  feedbackPanel = createFeedbackPanel({
    isVisible: () => state.tab === 'feedback',
    setBadge: (n) => {
      $('feedbackBadge').textContent = String(n);
      $('feedbackBadge').hidden = !n;
    },
    // The tab stays out of the way until there is something in it.
    onFirstResult: () => {
      if (!TABS.includes('feedback')) TABS.splice(TABS.indexOf('transcript'), 0, 'feedback');
      enableTab('feedback');
      const m = $('menuFeedback');
      if (m) m.hidden = false;
    },
  });
}

// Desktop: the panel starts open on the most useful tab for each role.
if (window.matchMedia('(min-width: 1101px)').matches) openTab(isHost ? 'eval' : 'transcript');
renderControls();
prepareLobby();
