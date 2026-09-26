// Creates/updates the SQLite database: syncs schema and generates the client.
// Usage: npm run db:setup   (reads DATABASE_URL from .env or the environment)
//
// Uses `prisma db push` instead of `prisma migrate deploy` to directly sync
// the database schema from schema.prisma. This bypasses the _prisma_migrations
// table entirely, which avoids phantom-applied migration issues on Railway
// where SQLite table-rebuild migrations can silently fail but still get recorded.
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
require('dotenv').config({ quiet: true });

const { resolveDatabaseUrl } = require('./db-url');

const url = resolveDatabaseUrl(process.env.DATABASE_URL);
const file = url.replace(/^file:/, '');
fs.mkdirSync(path.dirname(file), { recursive: true });
console.log(`[db] Database: ${path.relative(process.cwd(), file) || file}`);

const env = { ...process.env, DATABASE_URL: url };
const run = (cmd) => execSync(cmd, { stdio: 'inherit', env });

// Ensure critical columns exist before Prisma touches the database.
// SQLite table-rebuild migrations can silently fail on Railway but still
// get recorded in _prisma_migrations, leaving the DB out of sync.
if (fs.existsSync(file)) {
  const patchSql = "ALTER TABLE User ADD COLUMN role TEXT NOT NULL DEFAULT 'interviewer';";
  try {
    execSync(`echo "${patchSql}" | npx prisma db execute --schema prisma/schema.prisma --stdin`, { env, stdio: 'pipe' });
    console.log('[db] Patched: added User.role column.');
  } catch {
    // Silently ignore — column already exists or table not yet created.
  }
}

// db push compares schema.prisma directly against the live database and applies
// any missing columns/tables/indexes. It never consults _prisma_migrations.
run('npx prisma db push --skip-generate --accept-data-loss');
console.log('[db] Schema synced.');

if (!process.argv.includes('--skip-generate')) run('npx prisma generate');
console.log('[db] Ready.');
