import { timingSafeEqual } from 'node:crypto';
import type { Request, RequestHandler } from 'express';
import { UnauthorizedError } from './errors';

export type AuthApplication = { id: string; name: string };

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      application?: AuthApplication;
    }
  }
}

/** Constant-time comparison, so response timing does not reveal how much of a key matched. */
export function keysMatch(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function bearerToken(req: Request): string | undefined {
  const header = req.headers.authorization;
  return header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;
}

/** Lets a request through only with `Authorization: Bearer <expectedKey>`. Used for admin routes. */
export function createAdminAuth(expectedKey: string): RequestHandler {
  return (req, _res, next) => {
    const token = bearerToken(req);
    if (!token || !keysMatch(token, expectedKey)) return next(new UnauthorizedError());
    next();
  };
}

/** Turns an API key into an application, or null. Supplied by the applications module. */
export type ResolveApplication = (apiKey: string) => Promise<AuthApplication | null>;

/** Authenticates an application by its API key and puts it on `req.application`. */
export function createApplicationAuth(resolve: ResolveApplication): RequestHandler {
  return async (req, _res, next) => {
    const token = bearerToken(req);
    if (!token) return next(new UnauthorizedError());
    try {
      const application = await resolve(token);
      if (!application) return next(new UnauthorizedError('Invalid API key'));
      req.application = application;
      next();
    } catch (err) {
      next(err);
    }
  };
}

/** The authenticated application. Only call after createApplicationAuth has run. */
export function currentApplication(req: Request): AuthApplication {
  if (!req.application) throw new UnauthorizedError();
  return req.application;
}
