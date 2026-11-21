import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { askRequestBytes, assistantLimits, assistantRunSettings, classify, contextKeys, contextTurns, liveAssistantProvider, loadSource, loopCostRun, loopDefaults, routeMessage, routerRequests, routerTextBytes, routerTextSha256, runSettings, recordingProvider, replayProvider } from '@neburyx/ee-ask/eval';
import type { AssistantHooks, EvalHooks, ProviderLabel, RecordedAnswer } from '../hooks.js';

const made: string[] = [];

export function cleanUp(): void {
  for (const path of made.splice(0)) rmSync(path, { recursive: true, force: true });
}

export function scratch(prefix = 'ask-eval-test-'): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  made.push(path);
  return path;
}

/** The hooks the entry script gives the command, with the live provider replaced by one that answers from a function and counts nothing itself. */
export function hooksWith(answer: (question: string, promptId: string) => RecordedAnswer, label: ProviderLabel = { kind: 'anthropic' }): EvalHooks & AssistantHooks & { readonly asked: string[] } {
  const asked: string[] = [];
  const inner = {
    complete: async (request: { readonly values: string; readonly promptId: string; readonly version: number; readonly instructions?: string }) => {
      asked.push(request.values);
      const given = answer(request.values, request.promptId);
      const prompt = { id: request.promptId, version: request.version, sha256: createHash('sha256').update(request.instructions ?? '', 'utf8').digest('hex') };
      if ('reply' in given) return { status: 'ok' as const, text: given.reply, usage: { kind: 'known' as const, inputTokens: 10, outputTokens: 5, cacheReadTokens: 2 }, model: 'fixture', prompt };
      if ('declined' in given) return { status: 'refused' as const, usage: { kind: 'unknown' as const }, prompt };
      return { status: 'failed' as const, code: given.failure, usage: { kind: 'unknown' as const }, prompt };
    },
  };
  return {
    asked,
    loadSource: (folder, sourceId) => loadSource(folder, sourceId),
    classify: (source, provider, model, question) => classify(source as never, provider as never, model, question),
    askRequestBytes: (source, question) => askRequestBytes(source as never, question),
    replayProvider: (answers) => replayProvider(answers as never),
    recordingProvider: (provider, budget) => recordingProvider(provider as never, budget) as never,
    routeMessage: (source, provider, model, input) => routeMessage(source as never, provider as never, model, input) as never,
    routerRequests: (source, input) => routerRequests(source as never, input),
    routerTextSha256: (source) => routerTextSha256(source as never),
    contextKeys: (source, earlier, viewElementKeys) => contextKeys(source as never, earlier, viewElementKeys),
    contextTurns,
    routerTextBytes: (source) => routerTextBytes(source as never),
    assistantRunSettings,
    loopCostRun: (source, provider, model, input, steps) => loopCostRun(source as never, provider as never, model, input, steps),
    loopDefaults,
    assistantLimits,
    liveAssistantProvider: async () => ({ provider: inner, model: 'fixture-model', effort: 'medium', outputLimit: 4000, label }),
    runSettings,
    liveProvider: async () => ({ provider: inner, model: 'fixture-model', effort: 'medium', label }),
  };
}

const INTENTS = {
  byId: { parameters: ['id'], template: 'entity', settings: { ref: { entityType: 'thing', stableId: '$id' } } },
  pair: { parameters: ['first', 'second'], template: 'derived-edge-support', settings: { ruleId: 'rule', ends: [{ entityType: 'thing', stableId: '$first' }, { entityType: 'thing', stableId: '$second' }] } },
};

/** A private-shaped fixture: a folder in the product's shape, and a question file with the expectations of its questions. */
export function fixtureSet(questionsYaml: string, classification = 'Choose the intent that answers the question. Reply with one JSON object holding intent and entities.\n'): { readonly folder: string; readonly source: string; readonly questions: string; readonly root: string } {
  const root = scratch();
  const source = 'fixture-source';
  mkdirSync(join(root, 'folder', source), { recursive: true });
  writeFileSync(join(root, 'folder', source, 'classification.md'), classification);
  writeFileSync(join(root, 'folder', source, 'intents.json'), JSON.stringify(INTENTS));
  writeFileSync(join(root, 'questions.yaml'), questionsYaml);
  return { folder: join(root, 'folder'), source, questions: join(root, 'questions.yaml'), root };
}

export const QUESTIONS = `questions:
  - id: q1
    wording: Show thing one.
    expect: { intent: byId, entities: { id: T-1 } }
  - id: q2
    wording: Are two things linked, T-1 and T-2?
    expect: { intent: pair, entities: { first: T-1, second: T-2 } }
  - id: q3
    wording: What is the weather?
    expect: refuse
`;

export function io() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (line: string) => void out.push(line), err: (line: string) => void err.push(line), env: {} as Record<string, string | undefined> } };
}
