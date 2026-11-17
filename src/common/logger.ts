import pino from 'pino';
import { getConfig } from './config';

const config = getConfig();

export const logger = pino({
  level: config.LOG_LEVEL,
  redact: ['req.headers.authorization', 'req.headers.cookie'],
  transport:
    config.NODE_ENV === 'development'
      ? { target: 'pino-pretty', options: { singleLine: true } }
      : undefined,
});
