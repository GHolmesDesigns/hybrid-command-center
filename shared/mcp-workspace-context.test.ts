import { describe, expect, it } from 'vitest';
import {
  computeMcpCapabilityVersion,
  parseWorkspaceContextUri,
  utf8ByteLength,
  WORKSPACE_CONTEXT_BYTE_CEILING,
  WORKSPACE_CONTEXT_URI,
} from './mcp-workspace-context.ts';

describe('computeMcpCapabilityVersion', () => {
  it('changes when the tool set changes', () => {
    const before = computeMcpCapabilityVersion(['coordination_list_handoffs']);
    const after = computeMcpCapabilityVersion([
      'coordination_list_handoffs',
      'system_capabilities',
    ]);
    expect(before).not.toBe(after);
  });

  it('is stable for the same tool names in any order', () => {
    const left = computeMcpCapabilityVersion(['a', 'b', 'c']);
    const right = computeMcpCapabilityVersion(['c', 'a', 'b']);
    expect(left).toBe(right);
  });
});

describe('parseWorkspaceContextUri', () => {
  it('accepts the base resource URI', () => {
    expect(parseWorkspaceContextUri(WORKSPACE_CONTEXT_URI)).toEqual({});
  });

  it('parses section and include filters', () => {
    expect(
      parseWorkspaceContextUri(
        'hcc://workspace/context?sections=tools,workspace&include=clients,projects',
      ),
    ).toEqual({
      sections: ['tools', 'workspace'],
      include: ['clients', 'projects'],
    });
  });

  it('parses repeated section and include query params', () => {
    expect(
      parseWorkspaceContextUri('hcc://workspace/context?section=tools&section=workspace'),
    ).toEqual({
      sections: ['tools', 'workspace'],
    });
    expect(
      parseWorkspaceContextUri('hcc://workspace/context?include=clients&include=projects'),
    ).toEqual({
      include: ['clients', 'projects'],
    });
  });

  it('refuses malformed workspace context paths', () => {
    expect(() => parseWorkspaceContextUri('hcc://workspace/contextextra')).toThrow(
      /Unknown workspace/,
    );
    expect(() => parseWorkspaceContextUri('hcc://other/context')).toThrow(/Unknown workspace/);
    expect(() => parseWorkspaceContextUri('not-even-a-uri')).toThrow(/Unknown workspace/);
  });
});

describe('utf8ByteLength', () => {
  it('measures JSON text against the workspace ceiling constant', () => {
    expect(WORKSPACE_CONTEXT_BYTE_CEILING).toBeGreaterThan(1_000);
    expect(utf8ByteLength('{"ok":true}')).toBeGreaterThan(0);
  });
});
