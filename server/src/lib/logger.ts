import { pino, type LoggerOptions, type Logger as PinoLogger } from 'pino';
import { env } from '../config/env.js';

// Anything that could carry a credential or private content is redacted
// before it reaches a log sink.
export const redactPaths = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  '*.password',
  '*.password_hash',
  '*.passwordHash',
  '*.access_token',
  '*.accessToken',
  '*.refresh_token',
  '*.refreshToken',
  '*.token',
  '*.otp',
  '*.otp_code',
  '*.sdp',
  '*.candidate',
  '*.credential',
  '*.body',
  '*.text',
];

export const loggerOptions: LoggerOptions = {
  level: env.LOG_LEVEL,
  redact: { paths: redactPaths, censor: '[redacted]' },
  base: { service: 'parley-server' },
  ...((env.LOG_FORMAT ?? (env.NODE_ENV === 'development' ? 'pretty' : 'json')) === 'pretty'
    ? { transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname,service' } } }
    : {}),
};

export const logger = pino(loggerOptions);
export type Logger = PinoLogger;
