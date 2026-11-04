import { describe, expect, it } from 'vitest';
import { createToolRegistry, ToolError, TOOL_ORDER, type ToolEntry, type ToolRegistry } from './tool-registry.js';

const entry = (id: string, order = 100): ToolEntry => ({ id, label: id, icon: null, order, kind: { type: 'action', activate: () => undefined } });
const ids = (registry: ToolRegistry): string[] => registry.view.getState().map((tool) => tool.id);

describe('the tool registry', () => {
  it('refuses a second tool with an ID that is registered, with TOOL_TAKEN, and keeps the first', () => {
    const registry = createToolRegistry();
    const first = entry('a');
    registry.register(first);
    expect(() => registry.register(entry('a'))).toThrow(ToolError);
    expect(() => registry.register(entry('a'))).toThrow('TOOL_TAKEN: a');
    expect(registry.view.getState()).toEqual([expect.objectContaining({ ...first, registration: expect.any(Number) })]);
  });

  it('lists tools by order, and tools of the same order in the order they were registered', () => {
    const registry = createToolRegistry();
    registry.register(entry('late', 30));
    registry.register(entry('first-tie', 20));
    registry.register(entry('early', 10));
    registry.register(entry('second-tie', 20));
    expect(ids(registry)).toEqual(['early', 'first-tie', 'second-tie', 'late']);
  });

  it('takes out only the registration its function belongs to, and does nothing when it is called again', () => {
    const registry = createToolRegistry();
    const removeA = registry.register(entry('a', 10));
    registry.register(entry('b', 20));
    removeA();
    expect(ids(registry)).toEqual(['b']);
    removeA();
    expect(ids(registry)).toEqual(['b']);
  });

  it('does not let the function of an earlier registration take out a later registration of the same ID', () => {
    const registry = createToolRegistry();
    const removeOld = registry.register(entry('a'));
    removeOld();
    registry.register(entry('a'));
    removeOld();
    expect(ids(registry)).toEqual(['a']);
  });

  it('gives each registration its own number, also to an ID that is registered again, so a later registration is told from an earlier one', () => {
    const registry = createToolRegistry();
    const removeFirst = registry.register(entry('a', 10));
    registry.register(entry('b', 20));
    const first = registry.view.getState().map((tool) => tool.registration);
    expect(new Set(first).size).toBe(2);
    removeFirst();
    registry.register(entry('a', 10));
    const [again, other] = registry.view.getState();
    expect(again?.id).toBe('a');
    expect(again?.registration).not.toBe(first[0]);
    expect(other?.registration).toBe(first[1]);
  });

  it('holds the seven orders of the reference sheet in the order the tools are drawn', () => {
    const orders = [TOOL_ORDER.explore, TOOL_ORDER.filters, TOOL_ORDER.paths, TOOL_ORDER.patterns, TOOL_ORDER.search, TOOL_ORDER.group, TOOL_ORDER.table];
    expect(orders).toEqual([...orders].sort((a, b) => a - b));
    expect(new Set(orders).size).toBe(7);
  });
});
