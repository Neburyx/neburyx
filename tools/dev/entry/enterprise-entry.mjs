import { pathToFileURL } from 'node:url';
import { registerProfileExtension } from '../../../services/api/dist/profile/extension.js';

registerProfileExtension({
  load: async () => {
    const { createEnterpriseExtension } = await import('../../../ee/ask/dist/index.js');
    return createEnterpriseExtension();
  },
});

const [target, ...args] = process.argv.slice(2);
process.argv = [process.argv[0], target, ...args];
await import(pathToFileURL(target).href);
