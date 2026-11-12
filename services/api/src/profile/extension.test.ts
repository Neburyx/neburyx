import { afterEach, describe, expect, it } from 'vitest';
import { clearRegisteredExtension, loadProfileExtension, registerProfileExtension, registeredExtensionLoader } from './extension.js';

afterEach(clearRegisteredExtension);

describe('the extension registry', () => {
  it('holds the loader that an entry script registers and nothing before', () => {
    expect(registeredExtensionLoader()).toBeUndefined();
    const loader = { load: async () => ({ name: 'fake', routeGroups: [] }) };
    registerProfileExtension(loader);
    expect(registeredExtensionLoader()).toBe(loader);
    clearRegisteredExtension();
    expect(registeredExtensionLoader()).toBeUndefined();
  });

  it('loads an extension with no routes', async () => {
    const extension = { name: 'fake', routeGroups: [] };
    expect(await loadProfileExtension({ load: async () => extension })).toEqual({ ok: true, extension });
  });
});
