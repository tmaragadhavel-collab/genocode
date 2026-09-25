import {
  Room,
  RoomEvent,
  Track,
  ConnectionState,
  DisconnectReason,
} from '/vendor/livekit-client.esm.mjs';
import { createEvaluationPanel } from './evaluation.js';
import { createTranscriber } from './stt.js';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const $ = (id) => document.getElementById(id);
const [, , sessionId, myRole] = location.pathname.split('/');
const joinKey = new URLSearchParams(location.search).get('key') || '';
const otherRole = myRole === 'interviewer' ? 'candidate' : 'interviewer';
const ROLE_LABEL = { interviewer: 'Interviewer', candidate: 'Candidate' };
const isHost = myRole === 'interviewer';

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
  transcriptionOk: true,
  tab: null, // open side-panel tab, or null when closed
  transcriptSeen: new Set(),
  partial: { interviewer: '', candidate: '' },
};

// Interviewer-only AI evaluation module (the server never sends evaluation data to candidates).
let evalPanel = null;

// Both roles: our own microphone → server speech-to-text (speaker set server-side).
const transcriber = createTranscriber({
  sendWS: (msg) => sendWS(msg),
  getMicTrack: () => {
    const pub = state.room?.localParticipant?.getTrackPublication(Track.Source.Microphone);
    return pub && !pub.isMuted && pub.track ? pub.track.mediaStreamTrack : null;
  },
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
  setTimeout(() => el.remove(), action ? 9000 : kind === 'error' ? 6000 : 3500);
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
    .on(RoomEvent.LocalTrackPublished, () => { render(); reportMedia(); })
    .on(RoomEvent.LocalTrackUnpublished, () => { render(); reportMedia(); })
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

async function setShare(on) {
  const lp = state.room?.localParticipant;
  if (!lp) return;
  if (on && presenter() && presenter() !== lp) {
    toast(`${presenter().name} is already presenting.`);
    return;
  }
  try {
    await lp.setScreenShareEnabled(on, { audio: true, selfBrowserSurface: 'exclude' });
  } catch (err) {
    toast(mediaError('screen', err), 'error', { label: 'Try again', run: () => setShare(true) });
  }
  render();
  reportMedia();
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
  if (shareBy) {
    const me = shareBy === state.room.localParticipant;
    setVideo(mainVideo, trackOf(shareBy, Track.Source.ScreenShare), { contain: true });
    $('mainPlaceholder').hidden = true;
    $('mainLabel').textContent = me ? 'You are presenting' : `${shareBy.name} is presenting`;
  } else {
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

function openTab(tab) {
  state.tab = tab;
  $('sidePanel').hidden = false;
  for (const t of ['eval', 'questions', 'transcript', 'chat']) {
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

function addTranscript(seg) {
  if (state.transcriptSeen.has(seg.id)) return;
  state.transcriptSeen.add(seg.id);
  $('transcriptEmpty').hidden = true;
  const el = document.createElement('div');
  el.className = `seg ${seg.speaker}`;
  const who = document.createElement('div');
  who.className = 'who';
  who.textContent = seg.speaker === myRole ? 'You' : nameOf(seg.speaker);
  const time = document.createElement('time');
  time.textContent = new Date(seg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  who.append(time);
  const text = document.createElement('p');
  text.textContent = seg.text;
  el.append(who, text);
  if (seg.lowConfidence) {
    const flag = document.createElement('span');
    flag.className = 'low-conf';
    flag.textContent = '⚠ low confidence';
    flag.title = 'The speech recognizer was unsure about this segment';
    who.append(flag);
  }
  const list = $('transcriptList');
  const partial = list.querySelector(`.seg.partial.${seg.speaker}`);
  list.insertBefore(el, partial || null);
  // Keep the DOM bounded in long interviews.
  const segs = list.querySelectorAll('.seg:not(.partial)');
  if (segs.length > 400) segs[0].remove();
  const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
  if (nearBottom) list.scrollTop = list.scrollHeight;
}

function setPartial(speaker, text) {
  const list = $('transcriptList');
  let el = list.querySelector(`.seg.partial.${speaker}`);
  if (!text) { el?.remove(); return; }
  if (!el) {
    el = document.createElement('div');
    el.className = `seg partial ${speaker}`;
    el.innerHTML = '<div class="who"></div><p></p>';
    list.appendChild(el);
  }
  el.querySelector('.who').textContent = `${speaker === myRole ? 'You' : nameOf(speaker)} · speaking…`;
  el.querySelector('p').textContent = text === '…' ? '' : text; // '…' = speaking, text not yet available
  $('transcriptEmpty').hidden = true;
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
  const chip = $('transcribeChip');
  chip.hidden = !(live && state.transcription !== 'unavailable');
  chip.textContent = state.transcriptionOk ? '● Transcribing' : '⚠ Transcription unavailable';
  chip.classList.toggle('warn', !state.transcriptionOk);
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
  if (msg.type === 'transcript_final') {
    state.partial[msg.speaker] = '';
    setPartial(msg.speaker, '');
    addTranscript(msg);
  } else if (msg.type === 'transcript_partial') {
    setPartial(msg.speaker, msg.text);
  }
  if (msg.type !== 'session_joined' && evalPanel?.onMessage(msg)) return;

  switch (msg.type) {
    case 'session_joined':
      state.transcription = msg.transcription || 'unavailable';
      state.transcriptionOk = msg.transcriptionStatus !== 'unavailable';
      transcriber.setMode(state.transcription);
      (msg.transcript || []).forEach(addTranscript);
      evalPanel?.onJoined(msg);
      applySnapshot(msg.interview);
      loadChatHistory(msg.history || [], msg.pending);
      reportMedia();
      renderStatus();
      renderControls();
      break;
    case 'interview_state':
      applySnapshot(msg.interview);
      break;
    case 'transcription_status':
      state.transcriptionOk = msg.status === 'ok';
      evalPanel?.setTranscriptionOk(state.transcriptionOk);
      syncLiveState();
      toast(state.transcriptionOk ? 'Transcription resumed' : 'Transcription unavailable — the interview continues', state.transcriptionOk ? '' : 'error');
      break;
    case 'speech_activity':
      // Whisper transcribes whole segments, so show a "speaking…" placeholder meanwhile.
      if (state.transcription === 'segments') setPartial(msg.speaker, msg.speaking ? '…' : '');
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
$('chatBtn').addEventListener('click', () => toggleTab('chat'));
$('sideClose').addEventListener('click', closePanel);
$('leaveBtn').addEventListener('click', leave);
$('chatForm').addEventListener('submit', sendChat);
$('chatInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) sendChat(e);
});
$('audioUnlock').addEventListener('click', () => state.room?.startAudio());

for (const t of TABS) {
  $(`tab-${t}`).hidden = false;
  $(`tab-${t}`).addEventListener('click', () => openTab(t));
}
// Arrow-key navigation between tabs (WAI-ARIA tabs pattern).
$('tabs').addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
  const i = TABS.indexOf(state.tab);
  const next = TABS[(i + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length];
  openTab(next);
  $(`tab-${next}`).focus();
});

document.querySelectorAll('#moreMenu .host-only').forEach((el) => { if (!isHost) el.remove(); });
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
}

// Desktop: the panel starts open on the most useful tab for each role.
if (window.matchMedia('(min-width: 1101px)').matches) openTab(isHost ? 'eval' : 'transcript');
renderControls();
prepareLobby();
