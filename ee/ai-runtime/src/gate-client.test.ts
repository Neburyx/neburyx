import type { ExtensionRequest } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { gateClientOf } from './gate-client.js';

describe('the gate client of a request', () => {
  it('carries the six capabilities of the request and nothing else', async () => {
    const sourceReadable = async (): Promise<void> => undefined;
    const request: Pick<ExtensionRequest, 'askSourceReadable' | 'investigationReadable'> = { askSourceReadable: sourceReadable };
    const client = gateClientOf(request);
    expect(Object.keys(client).sort()).toEqual(['findPattern', 'investigationReadable', 'patterns', 'readElements', 'runner', 'sourceReadable']);
    expect(client.sourceReadable).toBe(sourceReadable);
    await expect(client.sourceReadable?.('s')).resolves.toBeUndefined();
  });

  it('leaves a member absent when the edition does not provide it', () => {
    const client = gateClientOf({});
    expect(client.runner).toBeUndefined();
    expect(client.readElements).toBeUndefined();
    expect(client.patterns).toBeUndefined();
  });

  it('does not copy any other member of the request, so AI code cannot reach one through it', () => {
    const client = gateClientOf({ signText: () => 'x', askSourceReadable: async () => undefined } as Pick<ExtensionRequest, 'askSourceReadable'>);
    expect(client).not.toHaveProperty('signText');
  });
});
