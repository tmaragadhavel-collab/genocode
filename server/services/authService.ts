import { randomBytes, scrypt as scryptCb, timingSafeEqual, createHash } from 'crypto';
import { promisify } from 'util';
import type { Request, Response, NextFunction } from 'express';
import type { PrismaClient } from '@prisma/client';

const scrypt = promisify(scryptCb) as (pw: string, salt: string, len: number) => Promise<Buffer>;

export type UserRole = 'interviewer' | 'candidate';

export type User = {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  passwordHash: string; // scrypt, hex
  salt: string;
  createdAt: number;
};

export type PublicUser = { id: string; email: string; name: string; role: UserRole };

type AuthSession = { userId: string; expiresAt: number };

export const SESSION_COOKIE = 'ia_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const EMAIL_PATTERN = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;

export class AuthError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export class AuthService {
  private users = new Map<string, User>(); // by id
  private sessions = new Map<string, AuthSession>();
  constructor(
    private readonly prisma: PrismaClient,
    private readonly secureCookies: boolean
  ) {}

  /** Loads accounts and unexpired login sessions from the database. */
  async init(): Promise<void> {
    const now = new Date();
    await this.prisma.authSession.deleteMany({ where: { expiresAt: { lt: now } } });
    for (const u of await this.prisma.user.findMany()) {
      this.users.set(u.id, { ...u, role: (u.role as UserRole) || 'interviewer', createdAt: u.createdAt.getTime() });
    }
    for (const s of await this.prisma.authSession.findMany()) {
      this.sessions.set(s.tokenHash, { userId: s.userId, expiresAt: s.expiresAt.getTime() });
    }
  }

  toPublic(u: User): PublicUser {
    return { id: u.id, email: u.email, name: u.name, role: u.role };
  }

  getUser(id: string): User | undefined {
    return this.users.get(id);
  }

  async signup(emailRaw: unknown, passwordRaw: unknown, nameRaw: unknown, roleRaw?: unknown): Promise<User> {
    const email = typeof emailRaw === 'string' ? emailRaw.trim().toLowerCase() : '';
    const name = typeof nameRaw === 'string' ? nameRaw.replace(/[\u0000-\u001F\u007F]/g, '').trim() : '';
    const password = typeof passwordRaw === 'string' ? passwordRaw : '';
    const role: UserRole = roleRaw === 'candidate' ? 'candidate' : 'interviewer';
    if (!EMAIL_PATTERN.test(email) || email.length > 254) throw new AuthError(400, 'Enter a valid email address.');
    if (!name || name.length > 80) throw new AuthError(400, 'Enter your name (max 80 characters).');
    if (password.length < 8 || password.length > 200) throw new AuthError(400, 'Password must be 8–200 characters.');
    if ([...this.users.values()].some((u) => u.email === email)) {
      throw new AuthError(409, 'An account with this email already exists.');
    }
    const salt = randomBytes(16).toString('hex');
    const hash = await scrypt(password, salt, 64);
    const user: User = {
      id: `usr_${randomBytes(12).toString('base64url')}`,
      email,
      name,
      role,
      passwordHash: hash.toString('hex'),
      salt,
      createdAt: Date.now(),
    };
    await this.prisma.user.create({ data: { ...user, createdAt: new Date(user.createdAt) } });
    this.users.set(user.id, user);
    return user;
  }

  async login(emailRaw: unknown, passwordRaw: unknown): Promise<User> {
    const email = typeof emailRaw === 'string' ? emailRaw.trim().toLowerCase() : '';
    const password = typeof passwordRaw === 'string' ? passwordRaw.slice(0, 200) : '';
    const user = [...this.users.values()].find((u) => u.email === email);
    // Hash even for unknown emails so response time doesn't reveal which exist.
    const hash = await scrypt(password, user?.salt ?? 'no-such-user-salt', 64);
    if (!user || !timingSafeEqual(hash, Buffer.from(user.passwordHash, 'hex'))) {
      throw new AuthError(401, 'Incorrect email or password.');
    }
    return user;
  }

  // Sessions are keyed by SHA-256 of the cookie token, so a leaked database can't be replayed.
  async startSession(res: Response, user: User): Promise<void> {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = Date.now() + SESSION_TTL_MS;
    await this.prisma.authSession.create({ data: { tokenHash: hashToken(token), userId: user.id, expiresAt: new Date(expiresAt) } });
    this.sessions.set(hashToken(token), { userId: user.id, expiresAt });
    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: this.secureCookies,
      maxAge: SESSION_TTL_MS,
      path: '/',
    });
  }

  async endSession(req: Request, res: Response): Promise<void> {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (token) {
      this.sessions.delete(hashToken(token));
      await this.prisma.authSession.deleteMany({ where: { tokenHash: hashToken(token) } });
    }
    res.clearCookie(SESSION_COOKIE, { path: '/' });
  }

  /** Returns the signed-in interviewer for this request, if any. */
  currentUser(req: Request): User | null {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (!token) return null;
    const key = hashToken(token);
    const session = this.sessions.get(key);
    if (!session || session.expiresAt < Date.now()) {
      if (session) this.sessions.delete(key);
      return null;
    }
    return this.users.get(session.userId) ?? null;
  }

  /** Express middleware for JSON APIs that require a signed-in interviewer. */
  requireUser = (req: Request, res: Response, next: NextFunction): void => {
    const user = this.currentUser(req);
    if (!user) {
      res.status(401).json({ error: 'Please sign in.', code: 'unauthenticated' });
      return;
    }
    res.locals.user = user;
    next();
  };
}
