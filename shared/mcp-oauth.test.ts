import { describe, expect, it } from 'vitest';
import {
  buildMcpAuthorizationServerMetadata,
  buildMcpProtectedResourceMetadata,
  mcpOAuthWwwAuthenticateHeader,
} from './mcp-oauth.ts';

describe('shared mcp oauth metadata', () => {
  it('builds discovery documents at the deployment origin', () => {
    const issuer = 'https://hcc.example.com';
    expect(buildMcpProtectedResourceMetadata({ issuer })).toEqual({
      resource: 'https://hcc.example.com/api/mcp',
      authorization_servers: ['https://hcc.example.com'],
      scopes_supported: [
        'coordination:read',
        'coordination:write',
        'workspace:read',
        'workspace:write',
        'signal:write',
        'settings:write',
        'import:write',
        'drive:sync',
        'drive:write-request',
      ],
      bearer_methods_supported: ['header'],
    });
    expect(buildMcpAuthorizationServerMetadata({ issuer }).authorization_endpoint).toBe(
      'https://hcc.example.com/authorize',
    );
    expect(mcpOAuthWwwAuthenticateHeader(issuer)).toContain(
      'resource_metadata="https://hcc.example.com/.well-known/oauth-protected-resource"',
    );
  });
});
