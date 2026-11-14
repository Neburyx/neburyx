import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEnterpriseExtension } from '@neburyx/ee-ask';
import { parse } from 'yaml';
import { z } from 'zod';
import { repoRoot } from './pack-fixtures.js';

const PACKS_ROOT = join(repoRoot, 'domain-packs');
const made: string[] = [];

const expectSchema = z.union([z.literal('refuse'), z.strictObject({ intent: z.string(), entities: z.record(z.string(), z.string()) })]);
const questionsSchema = z.strictObject({ questions: z.array(z.strictObject({ id: z.string(), wording: z.string(), expect: expectSchema })) });
const intentsSchema = z.record(z.string(), z.object({ parameters: z.array(z.string()), query: z.string().optional(), template: z.string().optional(), settings: z.unknown().optional() }));

export type DemoQuestion = z.infer<typeof questionsSchema>['questions'][number];
type DemoIntents = z.infer<typeof intentsSchema>;

export interface DemoPack {
  readonly pack: string;
  readonly sourceId: string;
  readonly dir: string;
  readonly intents: DemoIntents;
  readonly questions: readonly DemoQuestion[];
}

/** The packs that ship an Ask folder, found by listing the folder of the packs: no pack is named here. */
export function demoPacks(): readonly DemoPack[] {
  return readdirSync(PACKS_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(PACKS_ROOT, entry.name, 'ask')))
    .map((entry) => {
      const dir = join(PACKS_ROOT, entry.name);
      const sourceId = /^ {2}- id: (\S+)/m.exec(readFileSync(join(dir, 'neburyx.yaml'), 'utf8'))?.[1];
      if (sourceId === undefined) throw new Error(`the ${entry.name} pack names no source id`);
      return {
        pack: entry.name,
        sourceId,
        dir,
        intents: intentsSchema.parse(JSON.parse(readFileSync(join(dir, 'ask', 'intents.json'), 'utf8'))),
        questions: questionsSchema.parse(parse(readFileSync(join(dir, 'questions.yaml'), 'utf8'))).questions,
      };
    });
}

/** A temporary Ask folder holding the pack's `ask/` as it is, in the subfolder named by the source id. */
export function copyOfAskFolder(pack: DemoPack, change?: (subfolder: string) => void): string {
  const root = mkdtempSync(join(tmpdir(), 'demo-ask-'));
  made.push(root);
  const subfolder = join(root, pack.sourceId);
  mkdirSync(subfolder);
  cpSync(join(pack.dir, 'ask'), subfolder, { recursive: true });
  change?.(subfolder);
  return root;
}

export function removeDemoFolders(): void {
  for (const path of made.splice(0)) rmSync(path, { recursive: true, force: true });
}

/** What the real extension says to the folder of one source: the start-up checks of the product, not a copy of them. */
export async function configuredWith(folder: string, sourceIds: readonly string[]) {
  const extension = createEnterpriseExtension();
  const outcome = await extension.configure?.({ preview: true }, { NEBURYX_ASK_API_KEY: 'not-a-real-key', NEBURYX_ASK_MAPPING_FOLDER: folder }, { sourceIds });
  return { extension, outcome };
}
