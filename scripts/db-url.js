// Shared by the server and scripts: SQLite paths in DATABASE_URL are resolved
// from the project root (Prisma would otherwise resolve them from prisma/).
const path = require('path');

function resolveDatabaseUrl(raw) {
  const url = raw || 'file:./data/interview.db';
  if (!url.startsWith('file:')) return url;
  const p = url.slice('file:'.length);
  const abs = path.isAbsolute(p) ? p : path.resolve(__dirname, '..', p);
  return `file:${abs.split(path.sep).join('/')}`;
}

module.exports = { resolveDatabaseUrl };
