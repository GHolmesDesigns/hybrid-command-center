import 'dotenv/config';
import path from 'node:path';

export const PROJECT_SUBFOLDERS = [
  '01_Admin',
  '02_Briefs',
  '03_Working_Files',
  '04_Review',
  '05_Final_Deliverables',
] as const;
export const config = {
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
