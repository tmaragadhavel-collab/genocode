import { BrowserWindow, screen, session, desktopCapturer } from 'electron';
import { join } from 'node:path';
import { setAssistantProtection } from './contentProtection';

function setupPermissions(): void {
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    const allowed = ['media', 'display-capture', 'audioCapture'];
    callback(allowed.includes(permission));
  });

  session.defaultSession.setPermissionCheckHandler((_webContents, permission) => {
    const allowed = ['media', 'display-capture', 'audioCapture'];
    return allowed.includes(permission);
  });

  // Screen sharing only ever captures the shareable workspace window: never the
  // entire screen and never the assistant window.
  session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
    const target = workspaceWindow?.getMediaSourceId();
    if (!target) {
      callback({});
      return;
    }
    desktopCapturer.getSources({ types: ['window'] }).then((sources) => {
      const source = sources.find((s) => s.id === target);
      callback(source ? { video: source } : {});
    }).catch(() => callback({}));
  });
}

let workspaceWindow: BrowserWindow | null = null;
let assistantWindow: BrowserWindow | null = null;

const SERVER_PORT = process.env.SERVER_PORT || '3001';
const SERVER_BASE = `http://localhost:${SERVER_PORT}`;

function getRendererUrl(hash: string): string {
  if (process.env.ELECTRON_RENDERER_URL) {
    return `${process.env.ELECTRON_RENDERER_URL}#${hash}`;
  }
  return `file://${join(__dirname, '../renderer/index.html')}#${hash}`;
}

export function createWorkspaceWindow() {
  setupPermissions();

  workspaceWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#0f172a',
    title: 'InterviewAI — Workspace',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  workspaceWindow.loadURL(SERVER_BASE);

  workspaceWindow.on('closed', () => {
    workspaceWindow = null;
  });

  return workspaceWindow;
}

export function createAssistantWindow() {
  const display = screen.getPrimaryDisplay();
  const { width, height, x, y } = display.workArea;

  assistantWindow = new BrowserWindow({
    width: 420,
    height: 720,
    x: Math.max(x + width - 450, x),
    y: y + 24,
    minWidth: 360,
    maxWidth: 480,
    minHeight: 600,
    backgroundColor: '#0b1120',
    frame: false,
    transparent: true,
    show: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: true,
    title: 'InterviewAI — Assistant',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  assistantWindow.loadURL(`${SERVER_BASE}/room-assets/coach-overlay.html`);
  setAssistantProtection(assistantWindow, true);

  assistantWindow.webContents.on('did-finish-load', () => {
    assistantWindow?.webContents.send('PROTECTION_STATE_CHANGED', { enabled: true });
  });

  assistantWindow.on('closed', () => {
    assistantWindow = null;
  });

  return assistantWindow;
}

export function getWorkspaceWindow() {
  return workspaceWindow;
}

export function getAssistantWindow() {
  return assistantWindow;
}
