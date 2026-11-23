import { promptRecordOf, type ModelProvider } from '@neburyx/ee-ask';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { realHooks } from '../testing/eval-hooks.js';
import { cli } from '../testing/harness.js';
import type { EvalHooks } from './hooks.js';

const reply = (...sentences: { text: string; cites: string[] }[]): string => JSON.stringify({ sentences });

/** Hooks whose scripted provider answers with the replies a test gives, in order (the last repeats), whatever the view. */
function replying(...replies: (string | 'fail')[]): EvalHooks<ModelProvider> {
  return {
    ...realHooks,
    scriptedProvider: () => {
      let index = 0;
      const inner: ModelProvider = {
        complete: async (request) => {
          const next = replies[Math.min(index, replies.length - 1)];
          index += 1;
          if (next === 'fail') return { status: 'failed', code: 'unreachable', prompt: promptRecordOf(request) };
          return { status: 'ok', text: next ?? '', usage: { kind: 'known', inputTokens: 100, outputTokens: 20 }, model: 'claude-sonnet-5-5', prompt: promptRecordOf(request) };
        },
      };
      return inner;
    },
  };
}

const viewSchema = z.object({
  id: z.string(),
  status: z.string(),
  calls: z.number(),
  checked: z.boolean(),
  sentencesWritten: z.number(),
  sentencesKept: z.number(),
  sentencesRemoved: z.number(),
  keysStripped: z.number(),
  keysRemoved: z.number(),
  namesKept: z.array(z.string()),
  verdictInTitle: z.number(),
  forReview: z.array(z.string()),
  wronglyRemoved: z.array(z.string()),
  slipped: z.array(z.string()),
  factsMissed: z.array(z.string()),
  claimsMade: z.array(z.string()),
  tokens: z.object({ known: z.boolean(), input: z.number(), output: z.number() }),
});
const reportSchema = z.object({ views: z.array(viewSchema), totals: z.record(z.string(), z.number()) });

async function viewOf(id: string, hooks: EvalHooks<ModelProvider>, env: Record<string, string> = {}, signal?: AbortSignal) {
  const result = await cli(['--stub', '--json', '--views', id], env, hooks, signal);
  const parsed = reportSchema.parse(JSON.parse(result.text));
  const view = parsed.views[0];
  if (view === undefined) throw new Error('no view');
  return { view, parsed, text: result.text };
}

describe('the report of a view', () => {
  it('holds the facts, claims, sentences, keys, calls, tokens and time of a click, and no sentence of the model and no value of an entity', async () => {
    const { view, parsed, text } = await viewOf('aml-cycle', replying(reply({ text: 'zzsentinelzz the account AC-7001 is listed.', cites: ['n1'] })));
    expect(view).toMatchObject({ status: 'ok', calls: 1, checked: true, sentencesWritten: 1, sentencesKept: 1, sentencesRemoved: 0, keysStripped: 0, keysRemoved: 0, tokens: { known: true, input: 100, output: 20 } });
    expect(parsed.totals).toMatchObject({ viewsRun: 1, sentencesWritten: 1 });
    expect(text).not.toContain('zzsentinelzz');
    expect(text).not.toContain('AC-7001');
  });

  it('names an invented name of the set that a kept sentence holds, a synthetic name', async () => {
    const { view } = await viewOf('aml-cycle', replying(reply({ text: 'quill haverd is also linked to AC-7001.', cites: ['n1'] })));
    expect(view.namesKept).toEqual(['Quill Haverd']);
  });

  it('sums the keys the checks take out over every reply they judged, and reports the diagnostics of the last checked reply only', async () => {
    const first = reply({ text: 'The account AC-7001 is listed (n1).', cites: ['n1'] }, { text: 'n1 sent funds on.', cites: ['n1'] }, { text: 'This is evidence of fraud.', cites: ['n1'] });
    const second = reply({ text: 'The account AC-7002 is listed (n2).', cites: ['n2'] });
    const { view } = await viewOf('aml-cycle', replying(first, second));
    expect(view).toMatchObject({ calls: 2, keysStripped: 2, keysRemoved: 1, sentencesWritten: 1, sentencesKept: 1, sentencesRemoved: 0 });
  });

  it('separates a removal whose verdict word lies only in a title, a removal for a person to read, and a removal for another cause', async () => {
    const title = { text: 'Crimson Lake Traders connects from the address ip-00000.', cites: ['n3', 'e1'] };
    const unexplained = { text: 'The accounts AC-3001 and AC-3002 connect from the address ip-00000 on 12 occasions.', cites: ['n1', 'n2', 'n3', 'e1', 'e2'] };
    const verdict = { text: 'The address ip-00000 is evidence of fraud by the holders.', cites: ['n3'] };
    const { view } = await viewOf('gateway-address-with-a-business-title', replying(reply(title, unexplained, verdict)), { NEBURYX_SUMMARY_MAX_CALLS: '1' });
    expect(view).toMatchObject({ sentencesWritten: 3, sentencesKept: 0, sentencesRemoved: 3, verdictInTitle: 1, forReview: ['f1'] });
  });

  it('keeps a sentence that quotes the title of an element it cites, with no further call, and removes the same title for an element it does not cite', async () => {
    const cited = { text: 'Crimson Lake Traders connects from the address ip-00000.', cites: ['n1', 'n3', 'e1'] };
    const kept = (await viewOf('gateway-address-with-a-business-title', replying(reply(cited)))).view;
    expect(kept).toMatchObject({ status: 'ok', calls: 1, sentencesKept: 1, sentencesRemoved: 0, verdictInTitle: 0 });
  });

  it('removes the same title for an element the sentence does not cite, and reports it as a verdict word only in a title', async () => {
    const uncited = { text: 'Crimson Lake Traders connects from the address ip-00000.', cites: ['n3', 'e1'] };
    const { view } = await viewOf('gateway-address-with-a-business-title', replying(reply(uncited)), { NEBURYX_SUMMARY_MAX_CALLS: '1' });
    expect(view).toMatchObject({ sentencesRemoved: 1, verdictInTitle: 1 });
  });

  it('does not count a sentence with a supported fact and verdict wording outside a title as a title removal or a removal for a person to read', async () => {
    const mixed = { text: 'Four accounts, AC-2000, AC-2001, AC-2002 and AC-2003, use the device DV-10. It is evidence of fraud by the holders.', cites: ['n1', 'n2', 'n3', 'n4', 'n5', 'e1', 'e2', 'e3', 'e4'] };
    const { view } = await viewOf('ring-on-one-device', replying(reply(mixed)), { NEBURYX_SUMMARY_MAX_CALLS: '1' });
    expect(view).toMatchObject({ sentencesRemoved: 1, verdictInTitle: 0, forReview: [] });
  });

  it('counts only the last checked reply when a further call replaced the first: a title removal of the first adds nothing', async () => {
    const first = reply({ text: 'Crimson Lake Traders connects from the address ip-00000.', cites: ['n3', 'e1'] });
    const second = reply({ text: 'The accounts AC-3001 and AC-3002 connect from the address ip-00000.', cites: ['n1', 'n2', 'n3', 'e1', 'e2'] });
    const { view } = await viewOf('gateway-address-with-a-business-title', replying(first, second));
    expect(view).toMatchObject({ status: 'ok', calls: 2, verdictInTitle: 0, sentencesWritten: 1, sentencesRemoved: 0 });
  });

  it('keeps the diagnostics of the last checked reply when a later call fails, and reports how the click ended', async () => {
    const first = reply({ text: 'Crimson Lake Traders connects from the address ip-00000.', cites: ['n3', 'e1'] });
    const { view } = await viewOf('gateway-address-with-a-business-title', replying(first, 'fail'));
    expect(view).toMatchObject({ status: 'failed', checked: true, verdictInTitle: 1, sentencesWritten: 1 });
  });

  it('keeps the diagnostics of the last checked reply when the click is cancelled after it, and reports it cancelled', async () => {
    const controller = new AbortController();
    const first = reply({ text: 'Crimson Lake Traders connects from the address ip-00000.', cites: ['n3', 'e1'] });
    const base = replying(first, first);
    const hooks: EvalHooks<ModelProvider> = {
      ...base,
      scriptedProvider: (replyFor) => {
        const inner = base.scriptedProvider(replyFor);
        let asked = 0;
        return { complete: async (request, signal) => (asked += 1, asked === 2 ? (controller.abort(), inner.complete(request, signal)) : inner.complete(request, signal)) };
      },
    };
    const { view } = await viewOf('gateway-address-with-a-business-title', hooks, {}, controller.signal);
    expect(view).toMatchObject({ status: 'cancelled', checked: true, verdictInTitle: 1 });
  });

  it('reports no diagnostics when no reply was checked, and that no reply was checked', async () => {
    const { view } = await viewOf('aml-cycle', replying('fail'));
    expect(view).toMatchObject({ status: 'failed', checked: false, sentencesWritten: 0, sentencesKept: 0, sentencesRemoved: 0, keysStripped: 0, verdictInTitle: 0, forReview: [] });
  });
});

describe('the labelled comparison and the keys, through the real checks', () => {
  it('counts the keys the checks take out of a sentence written in a list, and compares only the reply that was checked, with a key taken out of a labelled sentence still counting as kept', async () => {
    const verdict = reply({ text: 'This is evidence of fraud.', cites: ['n1'] });
    const second = reply({ text: 'The accounts AC-7001 and AC-7002 are listed (n1, n2).', cites: ['n1', 'n2'] }, { text: 'quill haverd is also linked to AC-7001.', cites: ['n1'] });
    const { view } = await viewOf('aml-cycle', replying(verdict, second));
    expect(view).toMatchObject({ calls: 2, keysStripped: 1, keysRemoved: 0, sentencesWritten: 2, sentencesKept: 2, wronglyRemoved: [], slipped: ['s8'] });
  });

  it('counts a good sentence of the checked reply that the checks removed as removed wrongly, and a labelled sentence that is not in the reply as neither', async () => {
    const base = replying(reply({ text: 'Nothing is said.', cites: ['n1'] }));
    const hooks: EvalHooks<ModelProvider> = {
      ...base,
      summarizer: async (options) => {
        const built = await base.summarizer({ ...options, observe: () => undefined });
        if (!built.ok) return built;
        const good = { text: 'The accounts AC-7001, AC-7002, AC-7003 and AC-7004 are listed.', cites: [] as string[] };
        return { ok: true, summarizer: { ...built.summarizer, summarize: async (reading, signal) => (options.observe({ written: [good], kept: [], removed: 1, rejected: [], keysStripped: 0, keysRemoved: 0, verdictFound: false }), built.summarizer.summarize(reading, signal)) } };
      },
    };
    const { view } = await viewOf('aml-cycle', hooks);
    expect(view.wronglyRemoved).toEqual([]);
    const keep = { text: 'The accounts AC-7001, AC-7002, AC-7003 and AC-7004 transfer in a cycle, ending back at AC-7001.', cites: ['n1', 'n2', 'n3', 'n4', 'e1', 'e2', 'e3', 'e4'] };
    const removing: EvalHooks<ModelProvider> = {
      ...base,
      summarizer: async (options) => {
        const built = await base.summarizer({ ...options, observe: () => undefined });
        if (!built.ok) return built;
        return { ok: true, summarizer: { ...built.summarizer, summarize: async (reading, signal) => (options.observe({ written: [keep], kept: [], removed: 1, rejected: [], keysStripped: 0, keysRemoved: 0, verdictFound: false }), built.summarizer.summarize(reading, signal)) } };
      },
    };
    expect((await viewOf('aml-cycle', removing)).view.wronglyRemoved).toEqual(['s1']);
  });
});

describe('the totals and the output forms', () => {
  it('holds the totals of the run in plain text and in JSON', async () => {
    const text = (await cli(['--stub', '--views', 'aml'])).text;
    expect(text).toMatch(/totals: views run 7, not run 0; facts \d+\/\d+; claims made 0/u);
    expect(text).toContain('keys stripped 0, keys removed 0 (every reply the checks judged)');
    expect(text).toContain('time ');
    const { parsed } = await viewOf('aml-cycle', realHooks);
    expect(parsed.totals).toMatchObject({ viewsRun: 1, viewsNotRun: 0, factsFound: 1, factsExpected: 1, claimsMade: 0, keysStripped: 0, keysRemoved: 0 });
  });

  it('shows the change of each count when a canary changes it: a fact missed, a claim made, a name kept, a sentence that slipped', async () => {
    const nothing = (await viewOf('aml-cycle', replying(reply({ text: 'Nothing is said.', cites: ['n1'] })))).view;
    expect(nothing.factsMissed).toEqual(['f1']);
    const claim = (await viewOf('aml-cycle', replying(reply({ text: 'The four accounts form a cycle, a round-trip of funds.', cites: ['n1', 'n2', 'n3', 'n4', 'e1', 'e2', 'e3', 'e4'] })))).view;
    expect(claim.claimsMade).toEqual(['c1']);
    const slip = (await viewOf('aml-cycle', replying(reply({ text: 'quill haverd is also linked to AC-7001.', cites: ['n1'] })))).view;
    expect(slip).toMatchObject({ namesKept: ['Quill Haverd'], slipped: ['s8'] });
  });
});
