import fs from 'fs';
import path from 'path';

const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(process.cwd(), 'data');

// One shared shutdown hook so every store flushes before the process exits.
const stores = new Set<{ flush(): void }>();
let exitHookInstalled = false;
function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  const flushAll = () => stores.forEach((s) => s.flush());
  process.once('beforeExit', flushAll);
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.once(sig, () => {
      flushAll();
      process.exit(0);
    });
  }
}

/**
 * Durable JSON file persistence for development / single-server deployments.
 * Writes are atomic (temp file + rename) and only happen when the serialized
 * state actually changed. Swap this for a database adapter in production.
 */
export class JsonStore<T> {
  private readonly file: string;
  private lastWritten = '';
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(name: string, private readonly snapshot: () => T) {
    this.file = path.join(DATA_DIR, `${name}.json`);
  }

  load(): T | null {
    try {
      const text = fs.readFileSync(this.file, 'utf-8');
      this.lastWritten = text;
      return JSON.parse(text) as T;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error(`[store] Could not read ${path.basename(this.file)}: ${(err as Error).message}`);
      }
      return null;
    }
  }

  /** Writes the current state if it changed since the last write. */
  flush(): void {
    const text = JSON.stringify(this.snapshot());
    if (text === this.lastWritten) return;
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, text, { mode: 0o600 });
      fs.renameSync(tmp, this.file);
      this.lastWritten = text;
    } catch (err) {
      console.error(`[store] Could not write ${path.basename(this.file)}: ${(err as Error).message}`);
    }
  }

  /** Periodically persists changes; also flushes on process exit. */
  autosave(intervalMs = 1500): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.flush(), intervalMs);
    this.timer.unref();
    stores.add(this);
    installExitHook();
  }
}
