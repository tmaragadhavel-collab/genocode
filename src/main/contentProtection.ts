import { BrowserWindow } from 'electron';

export function setAssistantProtection(win: BrowserWindow, enabled: boolean) {
  win.setContentProtection(enabled);
}
