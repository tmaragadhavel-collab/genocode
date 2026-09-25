import { app, BrowserWindow } from 'electron';
import { registerIpcHandlers } from './ipc/handlers';
import { createAssistantWindow, createWorkspaceWindow } from './windows';
import { registerShortcuts, unregisterShortcuts } from './shortcuts';

function createWindows() {
  createWorkspaceWindow();
  createAssistantWindow();
}

app.whenReady().then(() => {
  createWindows();
  registerIpcHandlers();
  registerShortcuts();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindows();
    }
  });
});

app.on('window-all-closed', () => {
  unregisterShortcuts();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  unregisterShortcuts();
});
