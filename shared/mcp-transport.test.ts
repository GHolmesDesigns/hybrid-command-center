/**
 * Shared transport header and protocol-version helpers (C133).
 */
import { describe, expect, it } from 'vitest';
import {
  MCP_PROTOCOL_VERSION,
  negotiateMcpProtocolVersion,
  isSupportedMcpProtocolVersion,
} from './mcp-transport.ts';

describe('mcp-transport', () => {
  it('negotiates a supported client version and falls back otherwise', () => {
    expect(negotiateMcpProtocolVersion('2025-06-18')).toBe('2025-06-18');
    expect(negotiateMcpProtocolVersion('2026-07-28')).toBe('2025-11-25');
    expect(negotiateMcpProtocolVersion('2025-11-25')).toBe('2025-11-25');
    expect(negotiateMcpProtocolVersion('nope')).toBe(MCP_PROTOCOL_VERSION);
    expect(negotiateMcpProtocolVersion(undefined)).toBe(MCP_PROTOCOL_VERSION);
    expect(isSupportedMcpProtocolVersion('2024-11-05')).toBe(true);
    expect(isSupportedMcpProtocolVersion('2020-01-01')).toBe(false);
  });
});
