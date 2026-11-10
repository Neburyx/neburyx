import pino from 'pino';
import { start, type StartIo, type StartResult } from '../start.js';
import { makeExportDirectory } from './export-directory.js';
import { makeWebRoot } from './web-root.js';

export const webRoot = makeWebRoot();
export const exportDirectory = makeExportDirectory();

export async function startApi(
  env: Readonly<Record<string, string | undefined>>,
  migrationsDirectory?: string,
  extra: Partial<StartIo> = {},
): Promise<{ readonly result: StartResult; readonly stderr: string }> {
  let stderr = '';
  const result = await start(
    { NEBURYX_WEB_ROOT: webRoot, ...env },
    { stderr: { write: (text) => (stderr += text) }, logger: pino({ level: 'silent' }), defaultWebRoot: webRoot, defaultExportDirectory: exportDirectory, portOverride: 0, ...(migrationsDirectory === undefined ? {} : { migrationsDirectory }), ...extra },
  );
  return { result, get stderr() { return stderr; } };
}

export async function stopApi(result: StartResult): Promise<void> {
  if (result.exitCode === 0) await result.app.close();
}
