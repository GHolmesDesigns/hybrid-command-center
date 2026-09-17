import { redactSecrets } from '../integration-log.ts';

const CLIENT_SENSITIVE_FIELDS = new Set(['email', 'phone', 'notes']);
const PATH_PATTERN = /(?:^|[\s"'`])(?:[A-Za-z]:\\|\/(?:Users|home|var|tmp|opt|data|mnt)[\\/][^\s"'`]+)/g;
const SSM_PATTERN = /\/hcc\/(?:production|staging)\/[A-Za-z0-9_./-]+/g;
const INTEGRATION_PAYLOAD_KEYS = new Set([
  'entities',
  'entityCount',
  'correlationId',
  'rawResponse',
  'providerResponse',
  'payload',
]);

function redactString(text: string): string {
  let scrubbed = redactSecrets(text);
  scrubbed = scrubbed.replace(PATH_PATTERN, ' [path redacted]');
  scrubbed = scrubbed.replace(SSM_PATTERN, '[ssm redacted]');
  scrubbed = scrubbed.replace(/\bGOOGLE_TOKEN_ENCRYPTION_KEY\b/gi, '[encryption-key redacted]');
  scrubbed = scrubbed.replace(/\bASSISTANT_KEY_ENCRYPTION_KEY\b/gi, '[encryption-key redacted]');
  scrubbed = scrubbed.replace(/\bSESSION_SECRET\b/gi, '[session-secret redacted]');
  scrubbed = scrubbed.replace(/\bPOST_BRIDGE_API_KEY\b/gi, '[api-key redacted]');
  scrubbed = scrubbed.replace(/\bBUFFER_API_KEY\b/gi, '[api-key redacted]');
  return scrubbed;
}

/** Strip secrets, client contact fields, paths, SSM names, and integration payloads. */
export function redactAssistantContext<T>(value: T): T {
  return redactValue(value) as T;
}

function redactValue(value: unknown): unknown {
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (CLIENT_SENSITIVE_FIELDS.has(key)) {
        out[key] = '[redacted]';
        continue;
      }
      if (INTEGRATION_PAYLOAD_KEYS.has(key)) {
        out[key] = '[integration payload redacted]';
        continue;
      }
      out[key] = redactValue(child);
    }
    return out;
  }
  return value;
}
