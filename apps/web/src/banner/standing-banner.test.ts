import { describe, expect, it, vi } from 'vitest';
import { sampleBanner } from './banner-fixtures.js';
import { createBannerController } from './banner-controller.js';

describe('a standing banner the person can dismiss', () => {
  it('is taken away for good on dismiss, and runs onDismiss once', () => {
    const controller = createBannerController();
    const onDismiss = vi.fn();
    controller.setStanding(sampleBanner({ id: 'standing', onDismiss }));
    controller.dismiss('standing');
    expect(controller.view.getState().banner).toBeUndefined();
    controller.clear();
    expect(controller.view.getState().banner).toBeUndefined();
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('comes back after a request banner that replaced it is dismissed, and is still dismissible', () => {
    const controller = createBannerController();
    const onDismiss = vi.fn();
    controller.setStanding(sampleBanner({ id: 'standing', onDismiss }));
    controller.show(sampleBanner({ id: 'request' }));
    controller.dismiss('request');
    expect(controller.view.getState().banner?.id).toBe('standing');
    expect(onDismiss).not.toHaveBeenCalled();
    controller.dismiss('standing');
    expect(controller.view.getState().banner).toBeUndefined();
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('keeps coming back when it has no onDismiss', () => {
    const controller = createBannerController();
    controller.setStanding(sampleBanner({ id: 'standing', dismissible: false }));
    controller.dismiss('standing');
    expect(controller.view.getState().banner?.id).toBe('standing');
  });
});
