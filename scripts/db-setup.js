// Creates/updates the SQLite database: applies migrations and generates the client.
// Usage: npm run db:setup   (reads DATABASE_URL from .env or the environment)
//
// Repair logic: if prisma migrate deploy completes but a required column is
// still missing (phantom-applied migration), the stale migration record is
// rolled back via `prisma migrate resolve` and migrations are re-deployed.
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
const run = (cmd, opts = {}) =>
  execSync(cmd, { stdio: opts.capture ? 'pipe' : 'inherit', env, encoding: 'utf8', ...opts });

// ── Phase 1: Run migrations normally ─────────────────────────────────────
run('npx prisma migrate deploy');

// ── Phase 2: Verify critical schema invariants ───────────────────────────
// The add_user_role migration must have created User.role. On Railway the
// migration can be recorded as applied even when the DDL silently failed
// (SQLite table-rebuild + PRAGMA foreign_keys dance).

const CHECKS = [
  {
    migrationName: '20260925234030_add_user_role',
    verifySQL: 'SELECT "role" FROM "User" LIMIT 0',
    label: 'User.role',
  },
];

for (const check of CHECKS) {
  try {
    // Write the verify SQL to a temp file (cross-platform, avoids pipe/echo issues)
    const tmpFile = path.join(require('os').tmpdir(), `db_check_${Date.now()}.sql`);
    fs.writeFileSync(tmpFile, check.verifySQL);
    try {
      run(`npx prisma db execute --file "${tmpFile}"`, { capture: true });
      console.log(`[db] Verify: ${check.label} — OK`);
    } catch {
      console.log(`[db] Verify: ${check.label} — MISSING. Repairing…`);
      // Mark the migration as rolled-back so Prisma will re-apply it
      try {
        run(`npx prisma migrate resolve --rolled-back "${check.migrationName}"`);
        console.log(`[db] Repair: marked '${check.migrationName}' as rolled-back.`);
      } catch (resolveErr) {
        console.log(`[db] Repair: resolve command failed (${resolveErr.message}). Trying db push fallback.`);
      }
      // Re-deploy migrations (now the rolled-back one will be re-applied)
      try {
        run('npx prisma migrate deploy');
        console.log('[db] Repair: migrations re-deployed successfully.');
      } catch {
        // Last resort: force-sync the schema via db push
        console.log('[db] Repair: re-deploy failed. Falling back to prisma db push.');
        run('npx prisma db push');
      }
    } finally {
      try { fs.unlinkSync(tmpFile); } catch {}
    }
  } catch (err) {
    console.log(`[db] Verify check for ${check.label} skipped: ${err.message}`);
  }
}

// ── Phase 3: Generate the Prisma client ──────────────────────────────────
if (!process.argv.includes('--skip-generate')) run('npx prisma generate');
console.log('[db] Ready.');
