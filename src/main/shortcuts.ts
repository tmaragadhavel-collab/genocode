import { BrowserWindow, globalShortcut } from 'electron';
import { setAssistantProtection } from './contentProtection';
import { CHANNELS } from './ipc/channels';
import { getAssistantWindow } from './windows';

let protectionState = true;

export function getProtectionState() {
  return protectionState;
}

export function setProtectionState(enabled: boolean) {
  protectionState = enabled;
}

export function registerShortcuts() {
  globalShortcut.register('CommandOrControl+Shift+H', () => {
    const assistant = getAssistantWindow();
    if (assistant) {
      if (assistant.isVisible()) {
        assistant.hide();
      } else {
        assistant.show();
        assistant.focus();
      }
    }
  });

  globalShortcut.register('CommandOrControl+Shift+P', () => {
    const assistant = getAssistantWindow();
    if (assistant) {
      protectionState = !protectionState;
      setAssistantProtection(assistant, protectionState);
      BrowserWindow.getAllWindows().forEach((win) => {
        win.webContents.send(CHANNELS.PROTECTION_STATE_CHANGED, { enabled: protectionState });
      });
    }
  });
}

export function unregisterShortcuts() {
  globalShortcut.unregisterAll();
}
