/**
 * Bootstrap / rotate the single operator password (C51 / #177).
 *
 * Reads the password from stdin without echoing it into shell history, argv, or logs.
 * Writes the argon2id hash to the `operator_password_hash` settings row and revokes every
 * session. For a non-loopback bind, also set `OPERATOR_PASSWORD_HASH` in the environment to
 * the printed hash — the bind gate reads env, not the settings row.
 */
import readline from 'node:readline';
import { stdin as input, stdout as output, stderr } from 'node:process';
import { getDb } from '../db.ts';
import { OPERATOR_PASSWORD_HASH_SETTING_KEY, resetPassword } from '../auth/service.ts';
import { getSetting } from '../drive/service.ts';
import { MIN_PASSWORD_LENGTH } from '../auth/password.ts';

function readHidden(prompt: string): Promise<string> {
  if (!input.isTTY || !output.isTTY) {
    return new Promise((resolve, reject) => {
      const rl = readline.createInterface({ input, output: stderr });
      rl.question(prompt, (answer) => {
        rl.close();
        resolve(answer);
      });
      rl.on('error', reject);
    });
  }

  return new Promise((resolve, reject) => {
    stderr.write(prompt);
    const chunks: Buffer[] = [];
    const wasRaw = input.isRaw;
    input.setRawMode?.(true);
    input.resume();
    const onData = (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      if (text === '\n' || text === '\r' || text === '\u0004') {
        cleanup();
        stderr.write('\n');
        resolve(Buffer.concat(chunks).toString('utf8'));
        return;
      }
      if (text === '\u0003') {
        cleanup();
        reject(new Error('Cancelled.'));
        return;
      }
      if (text === '\u007f' || text === '\b') {
        chunks.pop();
        return;
      }
      chunks.push(Buffer.from(text, 'utf8'));
    };
    const cleanup = () => {
      input.off('data', onData);
      input.setRawMode?.(wasRaw ?? false);
      input.pause();
    };
    input.on('data', onData);
  });
}

async function main() {
  stderr.write(
    'Set or rotate the operator password.\n' +
      `Minimum length: ${MIN_PASSWORD_LENGTH} characters.\n` +
      'The password is not written to argv, shell history, or application logs.\n\n',
  );

  const first = await readHidden('New password: ');
  const second = await readHidden('Confirm password: ');
  if (first !== second) {
    throw new Error('Passwords do not match.');
  }

  const db = getDb();
  await resetPassword(db, { newPassword: first });
  const hash = getSetting(db, OPERATOR_PASSWORD_HASH_SETTING_KEY);
  if (!hash) throw new Error('Password hash was not stored.');

  stderr.write(
    '\nPassword stored in the local settings row and every session was revoked.\n' +
      'For a non-loopback bind, set OPERATOR_PASSWORD_HASH in the environment to:\n\n',
  );
  // Hash only on stdout so operators can redirect it into a secret store without the prose.
  output.write(`${hash}\n`);
}

main().catch((error) => {
  stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
