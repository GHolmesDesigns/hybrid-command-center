import path from 'node:path';
import express from 'express';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.ts';
import { config } from './config.ts';

const app = createApp();
if (process.env.NODE_ENV === 'production' || process.argv.includes('--production')) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist/client');
  app.use(express.static(root)); app.get('/{*splat}', (_req, res) => res.sendFile(path.join(root, 'index.html')));
}
app.listen(config.port, () => console.log(`Command Center API ready at http://localhost:${config.port}`));
