import { describe, expect, it, vi } from 'vitest';
import { createPanelRegistry, PanelError, type PanelEntry } from './panel-registry.js';

const content = () => null;
const dock = (id: string): PanelEntry => ({ id, title: id, placement: { kind: 'dock' }, content });
const floating = (id: string): PanelEntry => ({ id, title: id, placement: { kind: 'floating', side: 'right', top: 64 }, content });

describe('the panel registry', () => {
  it('lists panels in registration order, each with a registration number and the initial width of 320 when none is given', () => {
    const registry = createPanelRegistry();
    registry.register(floating('legend'));
    registry.register(dock('inspector'));
    registry.register({ ...floating('wide'), initialWidth: 400 });
    const panels = registry.view.getState();
    expect(panels.map((panel) => panel.id)).toEqual(['legend', 'inspector', 'wide']);
    expect(panels.map((panel) => panel.registration)).toEqual([1, 2, 3]);
    expect(panels.map((panel) => panel.initialWidth)).toEqual([320, 320, 400]);
  });

  it('refuses an ID that is registered with PANEL_TAKEN and keeps the first', () => {
    const registry = createPanelRegistry();
    registry.register(floating('legend'));
    const attempt = () => registry.register(floating('legend'));
    expect(attempt).toThrow(PanelError);
    expect(attempt).toThrow('PANEL_TAKEN');
    expect(registry.view.getState()).toHaveLength(1);
    expect(registry.view.getState()[0]?.registration).toBe(1);
  });

  it('refuses a second panel for the dock with DOCK_TAKEN, whatever its ID, and leaves the first and the floating ones alone', () => {
    const registry = createPanelRegistry();
    registry.register(dock('inspector'));
    registry.register(floating('legend'));
    expect(() => registry.register(dock('other'))).toThrow('DOCK_TAKEN');
    expect(registry.view.getState().map((panel) => panel.id)).toEqual(['inspector', 'legend']);
  });

  it('reports the code and the ID of a refusal', () => {
    const registry = createPanelRegistry();
    registry.register(dock('inspector'));
    try {
      registry.register(dock('other'));
      expect.unreachable();
    } catch (error) {
      expect(error).toMatchObject({ code: 'DOCK_TAKEN', panelId: 'other' });
    }
  });

  it('takes out only its own registration: a stale remover does nothing once the panel is registered again', () => {
    const registry = createPanelRegistry();
    const removeFirst = registry.register(dock('inspector'));
    removeFirst();
    expect(registry.view.getState()).toEqual([]);
    registry.register(dock('inspector'));
    removeFirst();
    expect(registry.view.getState().map((panel) => panel.id)).toEqual(['inspector']);
    expect(registry.view.getState()[0]?.registration).toBe(2);
  });

  it('frees the dock when its panel is taken out, and a remover called twice does nothing the second time', () => {
    const registry = createPanelRegistry();
    const remove = registry.register(dock('inspector'));
    remove();
    remove();
    expect(() => registry.register(dock('next'))).not.toThrow();
  });
});

describe('the panel registry\'s notice of a removal', () => {
  it('tells of the panel as it was registered when its own registration is taken out, once', () => {
    const onRemoved = vi.fn();
    const registry = createPanelRegistry({ onRemoved });
    const remove = registry.register(dock('inspector'));
    registry.register(floating('legend'));
    remove();
    remove();
    expect(onRemoved).toHaveBeenCalledTimes(1);
    expect(onRemoved).toHaveBeenCalledWith(expect.objectContaining({ id: 'inspector', registration: 1 }));
  });

  it('says nothing for a stale remover once the ID is registered again', () => {
    const onRemoved = vi.fn();
    const registry = createPanelRegistry({ onRemoved });
    const first = registry.register(dock('inspector'));
    first();
    registry.register(dock('inspector'));
    onRemoved.mockClear();
    first();
    expect(onRemoved).not.toHaveBeenCalled();
  });

  it('says nothing for a registration that was refused', () => {
    const onRemoved = vi.fn();
    const registry = createPanelRegistry({ onRemoved });
    registry.register(dock('inspector'));
    expect(() => registry.register(dock('other'))).toThrow('DOCK_TAKEN');
    expect(onRemoved).not.toHaveBeenCalled();
  });
});

describe('placing a registered panel', () => {
  it('changes its placement and keeps its registration number, and does nothing for an ID that is not registered', () => {
    const registry = createPanelRegistry();
    registry.register({ id: 'one', title: 'One', placement: { kind: 'floating', side: 'left', top: 10 }, content: () => null });
    const before = registry.view.getState()[0]?.registration;
    registry.place('one', { kind: 'floating', side: 'left', top: 10, inset: 99 });
    registry.place('missing', { kind: 'dock' });
    expect(registry.view.getState()).toHaveLength(1);
    expect(registry.view.getState()[0]).toMatchObject({ registration: before, placement: { kind: 'floating', side: 'left', top: 10, inset: 99 } });
  });
});
