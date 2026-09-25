// Creates/updates the SQLite database: applies migrations and generates the client.
// Usage: npm run db:setup   (reads DATABASE_URL from .env or the environment)
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
require('dotenv').config({ quiet: true });

const { resolveDatabaseUrl } = require('./db-url');

const url = resolveDatabaseUrl(process.env.DATABASE_URL);
const file = url.replace(/^file:/, '');
fs.mkdirSync(path.dirname(file), { recursive: true });
console.log(`[db] Database: ${path.relative(process.cwd(), file) || file}`);

const run = (cmd) => execSync(cmd, { stdio: 'inherit', env: { ...process.env, DATABASE_URL: url } });
run('npx prisma migrate deploy');
if (!process.argv.includes('--skip-generate')) run('npx prisma generate');
console.log('[db] Ready.');
