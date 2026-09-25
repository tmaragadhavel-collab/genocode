declare global {
  interface Window {
    appBridge: {
      on: (channel: string, callback: (...args: unknown[]) => void) => (...args: unknown[]) => void;
      off: (channel: string, listener: (...args: unknown[]) => void) => void;
      send: (channel: string, payload?: unknown) => Promise<unknown>;
      setProtection: (enabled: boolean) => Promise<{ enabled: boolean }>;
      toggleAssistant: (visible: boolean) => Promise<{ visible: boolean }>;
      setTheme: (theme: 'light' | 'dark') => Promise<{ theme: 'light' | 'dark' }>;
      updateCoach: (html: string) => Promise<{ ok: boolean }>;
      clearCoach: () => Promise<{ ok: boolean }>;
      setCoachStatus: (connected: boolean, text?: string) => Promise<{ ok: boolean }>;
      getServerPort: () => number;
    };
  }
}

export {};
