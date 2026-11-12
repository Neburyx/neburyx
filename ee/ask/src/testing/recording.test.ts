import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildPromptRegistry } from '../prompts.js';
import type { ModelRequest } from '../provider.js';
import { createFixtureProvider, replyKey } from './fixture.js';
import { createRecorder } from './recorder.js';
import { RecordingRefused, checkRecording, loadRecording, parseRecording, writeRecording, type Recording } from './recording.js';

const folder = mkdtempSync(join(tmpdir(), 'recording-'));
afterAll(() => rmSync(folder, { recursive: true, force: true }));
const SIGNAL = new AbortController().signal;
const PLAN: ModelRequest = { promptId: 'ask.plan', parameters: { catalog: 'T1', question: 'SENTINEL-QUESTION about ‹person#1›' } };
const SUMMARY: ModelRequest = { promptId: 'summary.view', parameters: { view: 'SENTINEL-VIEW ‹account#1›' } };

const recordingWith = (text: string): Recording => ({ format: 1, entries: [{ promptId: 'ask.plan', version: 1, reply: { kind: 'ok', text } }] });
const textsOf = (findings: ReturnType<typeof checkRecording>) => findings.map((finding) => `${finding.kind}: ${finding.token}`);

async function scriptedRecorder() {
  const built = await buildPromptRegistry();
  if (!built.ok) throw new Error(built.problems.join('; '));
  const inner = createFixtureProvider({
    registry: built.registry,
    model: 'claude-sonnet-5-5',
    replies: {
      [replyKey('ask.plan', 1)]: { kind: 'ok', text: 'plan for ‹person#1›', usage: { kind: 'known', inputTokens: 123_456, outputTokens: 7 } },
      [replyKey('summary.view', 1)]: { kind: 'refused' },
    },
  });
  return { registry: built.registry, recorder: createRecorder(inner) };
}

describe('the recorder', () => {
  it('returns the answer unchanged and keeps the answer, never a request parameter', async () => {
    const { recorder } = await scriptedRecorder();
    const answer = await recorder.provider.complete(PLAN, SIGNAL);
    expect(answer).toMatchObject({ status: 'ok', text: 'plan for ‹person#1›' });
    const json = JSON.stringify(recorder.recording());
    expect(json).toContain('plan for');
    expect(json).not.toContain('SENTINEL');
    expect(recorder.recording().entries).toEqual([{ promptId: 'ask.plan', version: 1, reply: { kind: 'ok', text: 'plan for ‹person#1›', usage: { kind: 'known', inputTokens: 123_456, outputTokens: 7 }, model: 'claude-sonnet-5-5' } }]);
  });

  it('replaces the entry of the same id and version, and orders the entries by id then version', async () => {
    const { recorder } = await scriptedRecorder();
    await recorder.provider.complete(SUMMARY, SIGNAL);
    await recorder.provider.complete(PLAN, SIGNAL);
    await recorder.provider.complete(PLAN, SIGNAL);
    expect(recorder.recording().entries.map((entry) => `${entry.promptId}@${entry.version}`)).toEqual(['ask.plan@1', 'summary.view@1']);
  });

  it('writes two recordings of the same answers byte for byte alike', async () => {
    const first = await scriptedRecorder();
    const second = await scriptedRecorder();
    await first.recorder.provider.complete(PLAN, SIGNAL);
    await first.recorder.provider.complete(SUMMARY, SIGNAL);
    await second.recorder.provider.complete(SUMMARY, SIGNAL);
    await second.recorder.provider.complete(PLAN, SIGNAL);
    await writeRecording(join(folder, 'a.json'), first.recorder.recording());
    await writeRecording(join(folder, 'b.json'), second.recorder.recording());
    expect(readFileSync(join(folder, 'a.json'), 'utf8')).toBe(readFileSync(join(folder, 'b.json'), 'utf8'));
  });

  it('round-trips: a recording that is written, loaded and used by a fixture answers as the inner provider did', async () => {
    const { registry, recorder } = await scriptedRecorder();
    const planAnswer = await recorder.provider.complete(PLAN, SIGNAL);
    const summaryAnswer = await recorder.provider.complete(SUMMARY, SIGNAL);
    const path = join(folder, 'round-trip.json');
    await writeRecording(path, recorder.recording());
    const loaded = parseRecording(readFileSync(path, 'utf8'));
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const replay = createFixtureProvider({ registry, replies: loaded.replies });
    expect(await replay.complete(PLAN, SIGNAL)).toEqual(planAnswer);
    expect(await replay.complete(SUMMARY, SIGNAL)).toEqual(summaryAnswer);
  });
});

describe('loading a recording', () => {
  const entry = (over: Record<string, unknown>) => JSON.stringify({ format: 1, entries: [{ promptId: 'ask.plan', version: 1, reply: { kind: 'ok', text: 't' }, ...over }] });

  it.each([
    ['text that is not JSON', 'not json', 'the recording is not valid JSON'],
    ['another format', JSON.stringify({ format: 2, entries: [] }), 'the recording has a format other than 1'],
    ['no list of entries', JSON.stringify({ format: 1 }), 'the recording has no list of entries'],
    ['an unknown prompt id', entry({ promptId: 'free.text' }), 'entry 1: the prompt id is unknown'],
    ['a version the registry is not at', entry({ version: 2 }), 'entry 1: was recorded against version 2 of ask.plan, and the registry is at 1'],
    ['a reply that is not valid', entry({ reply: { kind: 'ok' } }), 'entry 1: the reply is not valid'],
    ['a failure code that does not exist', entry({ reply: { kind: 'failed', code: 'exploded' } }), 'entry 1: the reply is not valid'],
    ['an entry that is not an object', JSON.stringify({ format: 1, entries: [7] }), 'entry 1: is not an entry'],
  ])('refuses %s, naming the entry', (_name, json, problem) => {
    expect(parseRecording(json)).toEqual({ ok: false, problems: [problem] });
  });

  it('accepts a recording with each reply kind', () => {
    const json = JSON.stringify({
      format: 1,
      entries: [
        { promptId: 'ask.plan', version: 1, reply: { kind: 'ok', text: 't', usage: { kind: 'unknown' }, model: 'm' } },
        { promptId: 'summary.view', version: 1, reply: { kind: 'refused', usage: { kind: 'known', inputTokens: 1, outputTokens: 2 } } },
        { promptId: 'assistant.route', version: 1, reply: { kind: 'failed', code: 'truncated' } },
      ],
    });
    expect(parseRecording(json).ok).toBe(true);
  });
});

describe('checking a recording for identifiers', () => {
  it.each([
    ['an e-mail address', 'write to jane.doe@example.com now', 'jane.doe@example.com'],
    ['a UUID', 'case 123e4567-e89b-12d3-a456-426614174000 is open', '123e4567-e89b-12d3-a456-426614174000'],
    ['a URL', 'see https://example.com/case/9 for it', 'https://example.com/case/9'],
    ['an IPv4 address', 'seen from 192.168.10.45 twice', '192.168.10.45'],
    ['a run of six digits', 'account 123456 is linked', '123456'],
    ['a card number written in groups', 'card 4111 1111 1111 1111 appears', '4111 1111 1111 1111'],
    ['a phone number written in groups', 'call +44 20 7946 0958 today', '+44 20 7946 0958'],
    ['a code', 'the account ACC-12345 is linked', 'ACC-12345'],
    ['a code in lower case', 'the account acc-12345 is linked', 'acc-12345'],
    ['a code with an underscore', 'the account acct_12345 is linked', 'acct_12345'],
    ['an IBAN-shaped text', 'pay GB82WEST12345698765432 now', 'GB82WEST12345698765432'],
    ['an e-mail address inside angle quotes', 'see ‹alice@example.com› here', 'alice@example.com'],
  ])('reports %s, naming the entry and the field', (_name, text, token) => {
    const findings = checkRecording(recordingWith(text));
    expect(findings.map((finding) => finding.token)).toContain(token);
    expect(findings[0]).toMatchObject({ entry: 'ask.plan@1', field: 'text' });
  });

  it('finds nothing in words, small numbers, placeholders of the exact form, ISO dates and token counts', () => {
    const text = 'Two accounts (‹account#1› and ‹account#2›) share ‹phone#3›. Opened on 2026-11-12, 3 transfers of 45 and 120.';
    expect(checkRecording(recordingWith(text))).toEqual([]);
    const counted: Recording = { format: 1, entries: [{ promptId: 'ask.plan', version: 1, reply: { kind: 'ok', text: 'fine', usage: { kind: 'known', inputTokens: 123_456, outputTokens: 654_321 } } }] };
    expect(checkRecording(counted)).toEqual([]);
  });

  it('treats only the exact placeholder form as a placeholder, so an identifier in angle quotes is reported', () => {
    expect(textsOf(checkRecording(recordingWith('‹ACC-12345› and ‹account#1›')))).toEqual(['a code: ACC-12345']);
  });

  it('reads the model and the failure code too', () => {
    const recording: Recording = { format: 1, entries: [{ promptId: 'ask.plan', version: 1, reply: { kind: 'ok', text: 'fine', model: 'host-10.1.2.3' } }] };
    expect(checkRecording(recording)).toMatchObject([{ field: 'model', kind: 'an IPv4 address' }]);
  });

  it('does not report an identifier that is in the allowed set, and reports any other', () => {
    const recording = recordingWith('ACC-12345 and ACC-99999');
    expect(textsOf(checkRecording(recording, { allowedIdentifiers: new Set(['ACC-12345']) }))).toEqual(['a code: ACC-99999']);
    expect(checkRecording(recording, { allowedIdentifiers: new Set(['ACC-12345', 'ACC-99999']) })).toEqual([]);
  });
});

describe('a recording with fields the format does not have', () => {
  const withExtra = JSON.stringify({
    format: 1,
    note: 'mail jane.doe@example.com',
    entries: [{ promptId: 'ask.plan', version: 1, request: { question: 'jane.doe@example.com' }, reply: { kind: 'ok', text: 'fine', note: 'jane.doe@example.com', secret: 1 } }],
  });

  it('is not written with them: only the known fields reach the file', async () => {
    const path = join(folder, 'extra.json');
    const recording = JSON.parse(withExtra) as Recording;
    await writeRecording(path, recording);
    const written = readFileSync(path, 'utf8');
    expect(written).not.toContain('jane.doe');
    expect(JSON.parse(written)).toEqual({ format: 1, entries: [{ promptId: 'ask.plan', version: 1, reply: { kind: 'ok', text: 'fine' } }] });
  });

  it('does not write or load an extra field inside a usage either', async () => {
    const json = JSON.stringify({
      format: 1,
      entries: [
        { promptId: 'ask.plan', version: 1, reply: { kind: 'ok', text: 'fine', usage: { kind: 'unknown', note: 'jane.doe@example.com' } } },
        { promptId: 'summary.view', version: 1, reply: { kind: 'refused', usage: { kind: 'known', inputTokens: 1, outputTokens: 2, note: 'jane.doe@example.com' } } },
      ],
    });
    const path = join(folder, 'usage-extra.json');
    await writeRecording(path, JSON.parse(json) as Recording);
    expect(readFileSync(path, 'utf8')).not.toContain('jane.doe');
    const loaded = parseRecording(json);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) expect(JSON.stringify(loaded.replies)).not.toContain('jane.doe');
  });

  it('cannot carry them through a load into the replies', () => {
    const loaded = parseRecording(withExtra);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) expect(JSON.stringify(loaded.replies)).not.toContain('jane.doe');
  });

  it('is checked on the fields it keeps, whatever the extra fields hold', () => {
    expect(checkRecording(JSON.parse(withExtra) as Recording)).toEqual([]);
  });
});

describe('loading a recording from a file', () => {
  it('reads the file and refuses a duplicate entry, a negative count and an invalid version without printing them', async () => {
    const path = join(folder, 'loaded.json');
    await writeRecording(path, recordingWith('a plan'));
    expect((await loadRecording(path)).ok).toBe(true);
    const duplicate = JSON.stringify({ format: 1, entries: [{ promptId: 'ask.plan', version: 1, reply: { kind: 'ok', text: 'a' } }, { promptId: 'ask.plan', version: 1, reply: { kind: 'ok', text: 'b' } }] });
    expect(parseRecording(duplicate)).toEqual({ ok: false, problems: ['entry 2: repeats ask.plan@1, which an earlier entry already holds'] });
    const negative = JSON.stringify({ format: 1, entries: [{ promptId: 'ask.plan', version: 1, reply: { kind: 'ok', text: 'a', usage: { kind: 'known', inputTokens: -1, outputTokens: 2 } } }] });
    expect(parseRecording(negative)).toEqual({ ok: false, problems: ['entry 1: the reply is not valid'] });
    const textVersion = JSON.stringify({ format: 1, entries: [{ promptId: 'ask.plan', version: 'jane.doe@example.com', reply: { kind: 'ok', text: 'a' } }] });
    const refused = parseRecording(textVersion);
    expect(refused).toEqual({ ok: false, problems: ['entry 1: was recorded against an invalid version of ask.plan, and the registry is at 1'] });
  });
});

describe('writing a recording', () => {
  it('refuses a recording with a finding, naming it, and writes no file', async () => {
    const path = join(folder, 'refused.json');
    const attempt = writeRecording(path, recordingWith('mail jane.doe@example.com, account 123456'));
    await expect(attempt).rejects.toBeInstanceOf(RecordingRefused);
    await expect(attempt).rejects.toThrow(/ask\.plan@1 text \(an e-mail address\)/);
    expect(existsSync(path)).toBe(false);
  });

  it('writes a clean recording, and one whose identifiers are all allowed', async () => {
    await writeRecording(join(folder, 'clean.json'), recordingWith('a plan for ‹person#1›'));
    expect(existsSync(join(folder, 'clean.json'))).toBe(true);
    await writeRecording(join(folder, 'allowed.json'), recordingWith('about ACC-12345'), { allowedIdentifiers: new Set(['ACC-12345']) });
    expect(existsSync(join(folder, 'allowed.json'))).toBe(true);
  });
});
