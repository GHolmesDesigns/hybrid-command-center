import 'dotenv/config';
import path from 'node:path';

export const PROJECT_SUBFOLDERS = [
  '01_Admin',
  '02_Briefs',
  '03_Working_Files',
  '04_Review',
  '05_Final_Deliverables',
] as const;
/**
 * The levels pino accepts. `LOG_LEVEL` is documented in `.env.example`, so it has to be the
 * value actually in use — pino does not read the variable on its own, and for a while nothing
 * else did either, which left the documented knob doing nothing. An unrecognized value falls
 * back to `info` rather than failing startup: a typo in a log level should not stop the app.
 */
const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];
const logLevel = (value: string | undefined): LogLevel =>
  LOG_LEVELS.includes(value as LogLevel) ? (value as LogLevel) : 'info';

export const config = {
  logLevel: logLevel(process.env.LOG_LEVEL?.trim().toLowerCase()),
  port: Number(process.env.PORT || 8787),
  host: process.env.HOST || '127.0.0.1',
  databasePath: path.resolve(process.env.DATABASE_PATH || './data/command-center.db'),
  appOrigin: process.env.APP_ORIGIN || 'http://localhost:5173',
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID || '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
    redirectUri:
      process.env.GOOGLE_REDIRECT_URI || 'http://localhost:8787/api/drive/oauth/callback',
    encryptionKey: process.env.GOOGLE_TOKEN_ENCRYPTION_KEY || '',
  },
};
