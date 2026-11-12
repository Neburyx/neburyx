import { readFile, writeFile } from 'node:fs/promises';
import { BUILT_IN_PROMPTS } from '../prompts.js';
import { FAILURE_CODES, PROMPT_IDS, type PromptId, type TokenUsage } from '../provider.js';
import { replyKey, type FixtureReplies, type FixtureReply } from './fixture.js';

export interface RecordedEntry {
  readonly promptId: PromptId;
  readonly version: number;
  readonly reply: FixtureReply;
}

export interface Recording {
  readonly format: 1;
  readonly entries: readonly RecordedEntry[];
}

export interface Finding {
  readonly entry: string;
  readonly field: string;
  readonly token: string;
  readonly kind: string;
}

export interface CheckOptions {
  readonly allowedIdentifiers?: ReadonlySet<string>;
}

const PLACEHOLDER = /‹[a-z]+#[0-9]+›/g;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MIN_IDENTIFYING_DIGITS = 6;

const DETECTORS: readonly (readonly [string, RegExp])[] = [
  ['an e-mail address', /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g],
  ['a URL', /\bhttps?:\/\/[^\s)]+/g],
  ['a UUID', /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi],
  ['an IPv4 address', /\b(?:\d{1,3}\.){3}\d{1,3}\b/g],
  ['an IBAN-shaped text', /\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b/g],
  ['a code', /\b[A-Za-z]{2,}[-_]?\d{3,}\b/g],
  ['a long number', /\+?\d[\d ().-]{4,}\d/g],
];

function isIdentifyingNumber(token: string): boolean {
  return !ISO_DATE.test(token) && token.replace(/\D/g, '').length >= MIN_IDENTIFYING_DIGITS;
}

function identifiersIn(text: string): readonly (readonly [string, string])[] {
  let rest = text.replace(PLACEHOLDER, ' ');
  const found: [string, string][] = [];
  for (const [kind, pattern] of DETECTORS) {
    rest = rest.replace(pattern, (token) => {
      if (kind === 'a long number' && !isIdentifyingNumber(token)) return token;
      found.push([kind, token]);
      return ' ';
    });
  }
  return found;
}

function stringFieldsOf(reply: FixtureReply): readonly (readonly [string, string])[] {
  if (reply.kind === 'ok') return [['text', reply.text], ...(reply.model === undefined ? [] : [['model', reply.model] as const])];
  if (reply.kind === 'failed') return [['code', reply.code]];
  return [];
}

function normalUsage(usage: TokenUsage): TokenUsage {
  return usage.kind === 'known'
    ? { kind: 'known', inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, ...(usage.cacheReadTokens === undefined ? {} : { cacheReadTokens: usage.cacheReadTokens }), ...(usage.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: usage.cacheWriteTokens }) }
    : { kind: 'unknown' };
}

function normalReply(reply: FixtureReply): FixtureReply {
  switch (reply.kind) {
    case 'ok':
      return { kind: 'ok', text: reply.text, ...(reply.usage === undefined ? {} : { usage: normalUsage(reply.usage) }), ...(reply.model === undefined ? {} : { model: reply.model }) };
    case 'refused':
      return { kind: 'refused', ...(reply.usage === undefined ? {} : { usage: normalUsage(reply.usage) }) };
    case 'failed':
      return { kind: 'failed', code: reply.code, ...(reply.usage === undefined ? {} : { usage: normalUsage(reply.usage) }) };
    default: {
      const unreachable: never = reply;
      return unreachable;
    }
  }
}

/** A copy that holds only the fields the format has, so a field that the check does not read cannot be written. */
export function normalizeRecording(recording: Recording): Recording {
  return { format: 1, entries: recording.entries.map((entry) => ({ promptId: entry.promptId, version: entry.version, reply: normalReply(entry.reply) })) };
}

/** A backstop, not proof: it reads the string fields for tokens that look like identifiers, and cannot see names, addresses or free text. */
export function checkRecording(recording: Recording, options: CheckOptions = {}): readonly Finding[] {
  const allowed = options.allowedIdentifiers ?? new Set<string>();
  const findings: Finding[] = [];
  for (const entry of normalizeRecording(recording).entries) {
    for (const [field, text] of stringFieldsOf(entry.reply)) {
      for (const [kind, token] of identifiersIn(text)) {
        if (!allowed.has(token)) findings.push({ entry: replyKey(entry.promptId, entry.version), field, token, kind });
      }
    }
  }
  return findings;
}

export class RecordingRefused extends Error {
  readonly findings: readonly Finding[];

  constructor(findings: readonly Finding[]) {
    super(`the recording holds ${findings.length} identifier-like token(s): ${findings.map((finding) => `${finding.entry} ${finding.field} (${finding.kind})`).join(', ')}`);
    this.findings = findings;
  }
}

export async function writeRecording(path: string, recording: Recording, options: CheckOptions = {}): Promise<void> {
  const normal = normalizeRecording(recording);
  const findings = checkRecording(normal, options);
  if (findings.length > 0) throw new RecordingRefused(findings);
  await writeFile(path, `${JSON.stringify(normal, null, 2)}\n`, 'utf8');
}

export type RecordingLoad = { readonly ok: true; readonly replies: FixtureReplies } | { readonly ok: false; readonly problems: readonly string[] };

function isCount(value: unknown): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isUsage(value: unknown): value is TokenUsage {
  if (typeof value !== 'object' || value === null || !('kind' in value)) return false;
  if (value.kind === 'unknown') return true;
  const cacheOk = (!('cacheReadTokens' in value) || value.cacheReadTokens === undefined || isCount(value.cacheReadTokens)) && (!('cacheWriteTokens' in value) || value.cacheWriteTokens === undefined || isCount(value.cacheWriteTokens));
  return value.kind === 'known' && 'inputTokens' in value && 'outputTokens' in value && isCount(value.inputTokens) && isCount(value.outputTokens) && cacheOk;
}

function isReply(value: unknown): value is FixtureReply {
  if (typeof value !== 'object' || value === null || !('kind' in value)) return false;
  const usageOk = !('usage' in value) || value.usage === undefined || isUsage(value.usage);
  if (value.kind === 'ok') return 'text' in value && typeof value.text === 'string' && usageOk && (!('model' in value) || value.model === undefined || typeof value.model === 'string');
  if (value.kind === 'refused') return usageOk;
  return value.kind === 'failed' && usageOk && 'code' in value && typeof value.code === 'string' && FAILURE_CODES.some((code) => code === value.code);
}

function isPromptId(value: unknown): value is PromptId {
  return PROMPT_IDS.some((id) => id === value);
}

export function parseRecording(json: string): RecordingLoad {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return { ok: false, problems: ['the recording is not valid JSON'] };
  }
  if (typeof data !== 'object' || data === null || !('format' in data) || data.format !== 1) return { ok: false, problems: ['the recording has a format other than 1'] };
  if (!('entries' in data) || !Array.isArray(data.entries)) return { ok: false, problems: ['the recording has no list of entries'] };
  const problems: string[] = [];
  const replies: Record<string, FixtureReply> = {};
  data.entries.forEach((entry: unknown, index) => {
    const where = `entry ${index + 1}`;
    if (typeof entry !== 'object' || entry === null || !('promptId' in entry) || !('version' in entry) || !('reply' in entry)) {
      problems.push(`${where}: is not an entry`);
      return;
    }
    if (!isPromptId(entry.promptId)) {
      problems.push(`${where}: the prompt id is unknown`);
      return;
    }
    if (entry.version !== BUILT_IN_PROMPTS[entry.promptId].version) {
      const recorded = typeof entry.version === 'number' && Number.isInteger(entry.version) ? `version ${entry.version}` : 'an invalid version';
      problems.push(`${where}: was recorded against ${recorded} of ${entry.promptId}, and the registry is at ${BUILT_IN_PROMPTS[entry.promptId].version}`);
      return;
    }
    if (!isReply(entry.reply)) {
      problems.push(`${where}: the reply is not valid`);
      return;
    }
    const key = replyKey(entry.promptId, entry.version);
    if (key in replies) {
      problems.push(`${where}: repeats ${key}, which an earlier entry already holds`);
      return;
    }
    replies[key] = normalReply(entry.reply);
  });
  return problems.length > 0 ? { ok: false, problems } : { ok: true, replies };
}

export async function loadRecording(path: string): Promise<RecordingLoad> {
  return parseRecording(await readFile(path, 'utf8'));
}
