import { contextBridge, ipcRenderer } from 'electron';

const CHANNELS = {
  PROTECTION_SET: 'PROTECTION_SET',
  PROTECTION_STATE_CHANGED: 'PROTECTION_STATE_CHANGED',
  ASSISTANT_TOGGLE_VISIBILITY: 'ASSISTANT_TOGGLE_VISIBILITY',
  THEME_CHANGED: 'THEME_CHANGED',
  COACH_CONTENT: 'COACH_CONTENT',
  COACH_STATUS: 'COACH_STATUS',
} as const;

const api = {
  on: (channel: string, callback: (...args: unknown[]) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, ...args: unknown[]) => callback(...args);
    ipcRenderer.on(channel, listener);
    return listener;
  },
  off: (channel: string, listener: (...args: unknown[]) => void) => {
    ipcRenderer.removeListener(channel, listener as (event: Electron.IpcRendererEvent, ...args: unknown[]) => void);
  },
  send: (channel: string, payload?: unknown) => {
    return ipcRenderer.invoke(channel, payload);
  },
  setProtection: (enabled: boolean) => {
    return ipcRenderer.invoke(CHANNELS.PROTECTION_SET, enabled);
  },
  toggleAssistant: (visible: boolean) => {
    return ipcRenderer.invoke(CHANNELS.ASSISTANT_TOGGLE_VISIBILITY, visible);
  },
  setTheme: (theme: 'light' | 'dark') => {
    return ipcRenderer.invoke(CHANNELS.THEME_CHANGED, theme);
  },
  updateCoach: (html: string) => {
    return ipcRenderer.invoke(CHANNELS.COACH_CONTENT, { html });
  },
  clearCoach: () => {
    return ipcRenderer.invoke(CHANNELS.COACH_CONTENT, { clear: true });
  },
  setCoachStatus: (connected: boolean, text?: string) => {
    return ipcRenderer.invoke(CHANNELS.COACH_STATUS, { connected, text });
  },
  getServerPort: () => 3001,
};

contextBridge.exposeInMainWorld('appBridge', api);
