import { describe, expect, it } from 'vitest';
import { registerStandInTools } from '../dev/stand-ins.js';
import { createClientState } from '../state/client-state.js';
import { createToolRegistry } from '../workspace/tool-registry.js';
import { registerPathsTool } from './paths-tool.js';

describe('the Paths tool and its stand-in', () => {
  it('takes the place of the stand-in, which is not registered beside it, and a stand-in registered first gives way', () => {
    const tools = createToolRegistry();
    registerPathsTool(tools, createClientState());
    registerStandInTools(tools);
    expect(tools.view.getState().filter((tool) => tool.id === 'paths').map((tool) => tool.label)).toEqual(['Paths']);
    const stand = createToolRegistry();
    const remove = registerStandInTools(stand);
    expect(stand.view.getState().some((tool) => tool.id === 'paths')).toBe(true);
    remove();
    registerPathsTool(stand, createClientState());
    registerStandInTools(stand);
    expect(stand.view.getState().filter((tool) => tool.id === 'paths')).toHaveLength(1);
  });
});
