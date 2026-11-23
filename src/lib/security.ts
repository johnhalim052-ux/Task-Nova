import crypto from 'node:crypto';
import path from 'node:path';
import type { Request } from 'express';
import jwt from 'jsonwebtoken';

const ephemeralFallbackSecret = crypto.randomBytes(32).toString('hex');

export function getJwtSecret(): string {
  const configured = process.env.JWT_SECRET?.trim();
  if (configured && configured.length >= 16) {
    return configured;
  }
  return ephemeralFallbackSecret;
}

export interface JwtSessionPayload {
  sub: number;
  uid: string;
  role: string;
  email: string;
}

export function signAuthToken(payload: JwtSessionPayload): string {
  const expiresIn = (process.env.JWT_EXPIRES_IN?.trim() || '7d') as jwt.SignOptions['expiresIn'];
  return jwt.sign(payload, getJwtSecret(), { expiresIn });
}

export function verifyAuthToken(token: string): JwtSessionPayload {
  const decoded = jwt.verify(token, getJwtSecret());
  if (typeof decoded !== 'object' || decoded === null) {
    throw new Error('Invalid token payload');
  }
  const sub = Number(decoded.sub);
  if (!Number.isInteger(sub) || typeof decoded.uid !== 'string' || typeof decoded.role !== 'string') {
    throw new Error('Malformed token claims');
  }
  return {
    sub,
    uid: decoded.uid,
    role: decoded.role,
    email: typeof decoded.email === 'string' ? decoded.email : '',
  };
}

export function generateRandomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('hex');
}

export function hashToken(rawToken: string): string {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

export function getClientIp(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0].trim().slice(0, 64);
  }
  return (req.ip || req.socket.remoteAddress || 'unknown').slice(0, 64);
}

export function maskDestinationAccount(method: string, destination: string): string {
  const value = destination.trim();
  if (method === 'paypal' && value.includes('@')) {
    const [local, domain] = value.split('@');
    const prefix = local.slice(0, 2);
    return `${prefix}***@${domain}`;
  }
  if (value.length <= 8) {
    return `${value.slice(0, 2)}***`;
  }
  return `${value.slice(0, 4)}****${value.slice(-4)}`;
}

export const UPLOAD_ROOT = path.resolve(process.cwd(), 'uploads');

export function resolveSafeUploadPath(filename: string): string | null {
  if (!/^[a-zA-Z0-9._-]+$/.test(filename)) {
    return null;
  }
  const resolved = path.resolve(UPLOAD_ROOT, filename);
  if (!resolved.startsWith(`${UPLOAD_ROOT}${path.sep}`)) {
    return null;
  }
  return resolved;
}
