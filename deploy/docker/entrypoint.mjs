import { registerProfileExtension } from './dist/profile/extension.js';

registerProfileExtension({
  load: async () => {
    const { createEnterpriseExtension } = await import('./ee/ask/dist/index.js');
    return createEnterpriseExtension();
  },
});

await import('./dist/cli.js');
