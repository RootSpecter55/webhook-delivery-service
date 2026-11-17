import type { RequestHandler } from 'express';
import type { z } from 'zod';
import { ValidationError } from './errors';

type Schemas = { body?: z.ZodType; query?: z.ZodType; params?: z.ZodType };

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Parsed, typed values set by the validate() middleware. */
      validated: { body?: unknown; query?: unknown; params?: unknown };
    }
  }
}

/** Validates body, query and params against Zod schemas; rejects with 400 and field details. */
export function validate(schemas: Schemas): RequestHandler {
  return (req, _res, next) => {
    const validated: Express.Request['validated'] = {};
    const issues: { location: string; path: string; message: string }[] = [];

    for (const location of ['body', 'query', 'params'] as const) {
      const schema = schemas[location];
      if (!schema) continue;
      const result = schema.safeParse(req[location] ?? {});
      if (result.success) {
        validated[location] = result.data;
      } else {
        for (const issue of result.error.issues) {
          issues.push({ location, path: issue.path.join('.'), message: issue.message });
        }
      }
    }

    if (issues.length > 0) return next(new ValidationError(issues));
    req.validated = validated;
    next();
  };
}
