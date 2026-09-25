import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';

// Output goes to electron-vite's default `out/` directory (see package.json "main").
export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    root: 'src/renderer',
    plugins: [react()],
  },
});
