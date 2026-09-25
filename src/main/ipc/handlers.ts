import { ipcMain, BrowserWindow } from 'electron';
import { setAssistantProtection } from '../contentProtection';
import { getAssistantWindow } from '../windows';
import { setProtectionState } from '../shortcuts';

export function registerIpcHandlers() {
  ipcMain.handle('PROTECTION_SET', (_event, enabled: boolean) => {
    const assistantWindow = getAssistantWindow();
    if (!assistantWindow) return { enabled: false };

    setAssistantProtection(assistantWindow, enabled);
    setProtectionState(enabled);
    const state = { enabled };

    BrowserWindow.getAllWindows().forEach((win) => {
      win.webContents.send('PROTECTION_STATE_CHANGED', state);
    });

    return state;
  });

  ipcMain.handle('ASSISTANT_TOGGLE_VISIBILITY', (_event, visible: boolean) => {
    const assistantWindow = getAssistantWindow();
    if (!assistantWindow) return { visible: false };

    if (visible) {
      assistantWindow.show();
      assistantWindow.focus();
    } else {
      assistantWindow.hide();
    }

    return { visible };
  });

  ipcMain.handle('THEME_CHANGED', (_event, theme: 'light' | 'dark') => {
    BrowserWindow.getAllWindows().forEach((win) => {
      win.webContents.send('THEME_CHANGED', { theme });
    });
    return { theme };
  });
}
