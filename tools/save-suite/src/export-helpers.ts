import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ExportFormat, type ExportRequest } from '@neburyx/contracts';
import { expect } from 'vitest';
import { exportRequestOf } from '../../../apps/web/src/exports/export-attempt.js';
import { ref, type Running, type Tab } from './rig.js';
import { arranged, LINKED } from './scenarios.js';

const folder = mkdtempSync(join(tmpdir(), 'save-suite-export-'));
let sequence = 0;
/** An idempotency key no other call of the run used. */
export const newKey = (): string => `save-suite-${String((sequence += 1)).padStart(8, '0')}-key`;

export const ENTITIES = [ref('hub', 'H-1'), ref('leaf', 'L-1'), ref('leaf', 'L-2'), ref('leaf', 'L-4'), ref('part', 'P-1')];
export const EDGES = [LINKED('r-L1'), LINKED('r-L2')];
export const request = (format: ExportFormat, over: Partial<ExportRequest> = {}): ExportRequest => ({ kind: 'view', format, entities: ENTITIES, edges: EDGES, aggregates: [], derived: [], ...over });

/** An investigation as a person leaves it, and a second tab that opens it again, as after a reload: the export is made from what the store brought back. */
export async function reopened(running: Running): Promise<{ readonly tab: Tab; readonly id: string }> {
  const { tab: first, id } = await arranged(running);
  first.dispose();
  const tab = running.tab();
  expect(await tab.openById(id)).toMatchObject({ kind: 'shown', id });
  tab.mapTypes(['hub', 'leaf', 'part'], ['LINKED', 'HAS']);
  return { tab, id };
}

export async function made(tab: Tab, id: string, format: ExportFormat, over: Partial<ExportRequest> = {}) {
  const created = await tab.client.createExport(id, request(format, over), newKey());
  if (!created.ok) throw new Error(`the export was refused: ${created.failure.code}`);
  const file = await tab.client.downloadExport(created.value.id);
  if (!file.ok) throw new Error(`the download was refused: ${file.failure.code}`);
  return { record: created.value, file: file.value };
}

/** The request the dialog of the web builds from what the canvas of the tab shows. */
export const viewRequest = (tab: Tab, format: ExportFormat): ExportRequest => exportRequestOf(tab.state.visibleGraph(), format);

/** The bytes of an export's file as the tab downloads them. */
export async function downloaded(tab: Tab, id: string): Promise<Buffer> {
  const file = await tab.client.downloadExport(id);
  if (!file.ok) throw new Error(`the download was refused: ${file.failure.code}`);
  return Buffer.from(await file.value.blob.arrayBuffer());
}

/** A zip's bytes written to a file of the suite's folder, for `unzip` to read. */
export function zipPath(bytes: Buffer): string {
  const path = join(folder, `export-${String((sequence += 1))}.zip`);
  writeFileSync(path, bytes);
  return path;
}

/** The text of the files of a zip, by name, as `unzip` reads them. */
export function unzipped(bytes: Buffer, names: readonly string[]): Record<string, string> {
  const path = zipPath(bytes);
  return Object.fromEntries(names.map((name) => [name, execFileSync('unzip', ['-p', path, name], { encoding: 'utf8' })]));
}

/** Removes the folder the zip files were opened in; a file calls it once when it is done. */
export const removeExportFolder = (): void => rmSync(folder, { recursive: true, force: true });
