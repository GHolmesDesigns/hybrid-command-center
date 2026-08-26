/* v8 ignore file -- exercised end to end by the required `npm run build:production-artifact` gate. */
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const output = path.join(root, 'dist', 'production');
const copy = (source: string, destination: string) => {
  const from = path.join(root, source);
  if (!fs.existsSync(from)) throw new Error(`Production artifact input is missing: ${source}`);
  fs.cpSync(from, path.join(output, destination), { recursive: true });
};

fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(output, { recursive: true });
for (const [source, destination] of [
  ['dist/client', 'dist/client'],
  ['server', 'server'],
  ['shared', 'shared'],
  ['docs', 'docs'],
  ['deploy/aws', 'deploy/aws'],
  ['package.json', 'package.json'],
  ['package-lock.json', 'package-lock.json'],
] as const) {
  copy(source, destination);
}
console.log(`Production artifact assembled at ${output}`);
