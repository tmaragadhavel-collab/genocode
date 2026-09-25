// Status/stream events use { type, payload }; chat events are flat { type, sessionId, ... }.
export type WSInbound = { type: string; payload?: unknown; timestamp?: unknown; [key: string]: unknown };
type WSMessageHandler = (msg: WSInbound) => void;

let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let handlers: WSMessageHandler[] = [];
// Re-sent on every (re)connect so the server re-binds this socket to the interview session.
let sessionJoin: { type: 'session_join'; sessionId: string; participantKey: string } | null = null;

const WS_URL = 'ws://localhost:3001';

export function connectWS(): void {
  if (ws?.readyState === WebSocket.OPEN || ws?.readyState === WebSocket.CONNECTING) return;

  try {
    ws = new WebSocket(WS_URL);

    ws.onopen = () => {
      console.log('[ws] Connected to server');
      if (sessionJoin) ws?.send(JSON.stringify(sessionJoin));
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data as string);
        handlers.forEach((h) => h(msg));
      } catch {
        // ignore parse errors
      }
    };

    ws.onclose = () => {
      console.log('[ws] Disconnected');
      ws = null;
      scheduleReconnect();
    };

    ws.onerror = () => {
      ws?.close();
    };
  } catch {
    scheduleReconnect();
  }
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectWS();
  }, 3000);
}

export function disconnectWS(): void {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (ws) {
    ws.close();
    ws = null;
  }
}

export function joinSession(sessionId: string, participantKey: string): void {
  sessionJoin = { type: 'session_join', sessionId, participantKey };
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(sessionJoin));
}

export function leaveSession(): void {
  sessionJoin = null;
}

/** Sends a chat message; returns false if the socket is not connected. */
export function sendChatMessage(sessionId: string, sender: 'candidate' | 'interviewer', message: string): boolean {
  if (ws?.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify({ type: 'chat_message', sessionId, sender, message }));
  return true;
}

export function sendWSMessage(type: string, payload: unknown): void {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type, payload, timestamp: new Date().toISOString() }));
  }
}

let wsSendCount = { system: 0, microphone: 0 };
let wsSendBytes = { system: 0, microphone: 0 };
let wsDropCount = { system: 0, microphone: 0 };

export function getWsSendCounts(): { system: number; microphone: number } {
  return { ...wsSendCount };
}

export function getWsAudioStats(): {
  sent: { system: number; microphone: number };
  bytes: { system: number; microphone: number };
  dropped: { system: number; microphone: number };
  readyState: number | null;
} {
  return {
    sent: { ...wsSendCount },
    bytes: { ...wsSendBytes },
    dropped: { ...wsDropCount },
    readyState: ws?.readyState ?? null,
  };
}

export function sendAudioData(source: 'system' | 'microphone', data: ArrayBuffer): void {
  if (ws?.readyState !== WebSocket.OPEN) {
    wsDropCount[source]++;
    if (wsDropCount[source] === 1) {
      console.warn(`[ws] Dropping ${source} audio — WebSocket not open (readyState=${ws?.readyState})`);
    }
    return;
  }

  const uint8 = new Uint8Array(data);
  let binary = '';
  for (let i = 0; i < uint8.length; i++) {
    binary += String.fromCharCode(uint8[i]);
  }
  const base64 = btoa(binary);

  wsSendCount[source]++;
  wsSendBytes[source] += data.byteLength;
  if (wsSendCount[source] === 1 || wsSendCount[source] % 100 === 0) {
    console.log(`[ws] ${source} audio packets sent: ${wsSendCount[source]} (${base64.length} b64 chars)`);
  }

  ws.send(JSON.stringify({
    type: 'audio_data',
    payload: { source, data: base64 },
    timestamp: new Date().toISOString(),
  }));
}

export function onWSMessage(handler: WSMessageHandler): () => void {
  handlers.push(handler);
  return () => {
    handlers = handlers.filter((h) => h !== handler);
  };
}

export function isWSConnected(): boolean {
  return ws?.readyState === WebSocket.OPEN;
}
