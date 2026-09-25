import { PrismaClient } from '@prisma/client';

// Shared with scripts/db-setup.js so the CLI and the server use the same file.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { resolveDatabaseUrl } = require('../../scripts/db-url') as { resolveDatabaseUrl: (raw?: string) => string };

let client: PrismaClient | null = null;

export function getPrisma(): PrismaClient {
  client ??= new PrismaClient({ datasourceUrl: resolveDatabaseUrl(process.env.DATABASE_URL) });
  return client;
}

/** Fails fast with a clear message if migrations were never applied. */
export async function assertDatabaseReady(prisma: PrismaClient): Promise<void> {
  try {
    await prisma.interview.count();
  } catch (err) {
    throw new Error(`Database is not set up (${(err as Error).message.split('\n')[0]}). Run: npm run db:setup`);
  }
}
