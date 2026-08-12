import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { stopWhenTheRunEnds } from './shutdown.ts';

const self = fileURLToPath(import.meta.url);

if (process.argv.includes('--parent')) {
  const child = spawn(process.execPath, ['--experimental-strip-types', self], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdout?.pipe(process.stdout);
  child.stderr?.pipe(process.stderr);
  console.log(`CHILD ${child.pid}`);
  // Stay alive with the child's stdin held open so a parent kill, not an early EOF,
  // is what the fixture has to notice.
  await new Promise(() => {});
}

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url?.split('?')[0] === '/stop') {
    res.statusCode = 204;
    res.end(() => {
      stop('endpoint');
      stop('endpoint-again');
    });
    return;
  }
  res.statusCode = 200;
  res.end('ok');
});

const stop = stopWhenTheRunEnds(
  'fixture',
  () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
);

server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  console.log(`READY ${port}`);
});
