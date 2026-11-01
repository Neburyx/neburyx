import { describe, expect, it } from 'vitest';
import { AppError } from '../errors.js';
import type { AuditEvent, AuditSink, PolicyProvider } from '../seams/seams.js';
import {
  fakeClock,
  gateRequest,
  harness,
  LOCAL_PRINCIPAL,
  rowsOf,
  SOURCE_A,
  testTemplate,
  TestExecutor,
  testCatalog,
  type HarnessOptions,
} from '../testing/gate.js';
import type { GateStage } from './types.js';

function recordingAudit(): AuditSink & { readonly events: AuditEvent[] } {
  const events: AuditEvent[] = [];
  return { events, record: (event) => Promise.resolve(void events.push(event)) };
}

const denyingPolicy: PolicyProvider = { authorizeSource: () => Promise.resolve({ allowed: false, reason: 'no grant' }) };

function expectedEvent(action: string, result: AuditEvent['result']): AuditEvent {
  return { actorId: LOCAL_PRINCIPAL.id, actorRole: LOCAL_PRINCIPAL.role, action, result, sourceId: SOURCE_A, traceId: 'tr-test' };
}

interface FailureCase {
  readonly name: string;
  readonly options: (audit: AuditSink) => HarnessOptions;
  readonly request?: Parameters<typeof gateRequest>[0];
  readonly code: string;
  readonly result: AuditEvent['result'];
  readonly action: string;
  readonly reached: readonly GateStage[];
}

const failures: readonly FailureCase[] = [
  {
    name: 'resolve context (a budgets function that throws)',
    options: (audit) => ({
      seams: { audit },
      budgetsFor: () => {
        throw new Error('no budgets');
      },
    }),
    code: 'INTERNAL_ERROR',
    result: 'failed',
    action: 'gate.read',
    reached: ['resolve'],
  },
  {
    name: 'validate (an unknown template)',
    options: (audit) => ({ seams: { audit } }),
    request: { templateId: 'no-such-template' },
    code: 'INVALID_REQUEST',
    result: 'refused',
    action: 'gate.read',
    reached: ['resolve', 'validate'],
  },
  {
    name: 'authorize (a policy that denies)',
    options: (audit) => ({ seams: { audit, policy: denyingPolicy } }),
    code: 'ACCESS_DENIED',
    result: 'denied',
    action: 'test.read',
    reached: ['resolve', 'validate', 'authorize'],
  },
  {
    name: 'execute (an executor that times out)',
    options: (audit) => ({ seams: { audit }, executor: new TestExecutor(() => Promise.resolve({ status: 'timeout' })) }),
    code: 'QUERY_TIMEOUT',
    result: 'failed',
    action: 'test.read',
    reached: ['resolve', 'validate', 'authorize', 'execute'],
  },
  {
    name: 'normalize (a normalizer that throws)',
    options: (audit) => ({
      seams: { audit },
      catalog: testCatalog([
        testTemplate({
          normalize: () => {
            throw new Error('bad row');
          },
        }),
      ]),
    }),
    code: 'INTERNAL_ERROR',
    result: 'failed',
    action: 'test.read',
    reached: ['resolve', 'validate', 'authorize', 'execute', 'normalize'],
  },
  {
    name: 'redact (a redactor that throws)',
    options: (audit) => ({
      seams: { audit },
      redact: () => {
        throw new Error('cannot mask');
      },
    }),
    code: 'INTERNAL_ERROR',
    result: 'failed',
    action: 'test.read',
    reached: ['resolve', 'validate', 'authorize', 'execute', 'normalize', 'redact'],
  },
];

describe('a failure at any stage', () => {
  it.each(failures)('at $name gives the normalized error and still reaches audit', async (failure) => {
    const audit = recordingAudit();
    const { gate, observer } = harness(failure.options(audit));
    const outcome = await gate.run(gateRequest(failure.request)).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(outcome).toBeInstanceOf(AppError);
    expect(outcome).toMatchObject({ code: failure.code });
    expect(observer.events.map((event) => event.stage)).toEqual([...failure.reached, 'audit']);
    expect(observer.events.filter((event) => event.outcome === 'failed').map((event) => event.stage)).toEqual([failure.reached.at(-1)]);
    expect(audit.events).toEqual([expectedEvent(failure.action, failure.result)]);
  });
});

describe('an audit sink that rejects', () => {
  const rejecting = (): AuditSink & { calls: number } => {
    const sink = { calls: 0, record: () => (sink.calls++, Promise.reject(new Error('audit store down'))) };
    return sink;
  };

  it('does not change a successful page, is tried once, and logs without event data', async () => {
    const audit = rejecting();
    const { gate, logs } = harness({ seams: { audit } });
    const page = await gate.run(gateRequest());
    expect(page.items).toHaveLength(10);
    expect(audit.calls).toBe(1);
    expect(logs.map((entry) => entry.fields)).toEqual([{ event: 'gate.audit_failed' }]);
  });

  it('does not change the original error of an earlier stage, is tried once, and logs without event data', async () => {
    const audit = rejecting();
    const { gate, logs } = harness({ seams: { audit, policy: denyingPolicy } });
    await expect(gate.run(gateRequest())).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
    expect(audit.calls).toBe(1);
    expect(logs.map((entry) => entry.fields)).toEqual([{ event: 'gate.audit_failed' }]);
  });
});

describe('a request that succeeds', () => {
  it('passes the seven stages in order and returns the normalized and redacted items', async () => {
    const audit = recordingAudit();
    const { gate, observer, executor } = harness({
      seams: { audit },
      executor: new TestExecutor(() => Promise.resolve(rowsOf(2))),
      redact: (items) => items.map((item) => ({ title: String(item['title']).toUpperCase() })),
    });
    const page = await gate.run(gateRequest());
    expect(observer.events).toEqual(
      (['resolve', 'validate', 'authorize', 'execute', 'normalize', 'redact', 'audit'] as const).map((stage) => ({ stage, outcome: 'ok' })),
    );
    expect(page).toEqual({ items: [{ title: 'ITEM 1' }, { title: 'ITEM 2' }], hasMore: false });
    expect(executor.calls).toHaveLength(1);
  });

  it('records one audit event with the actor, action, source, trace ID and result, and no parameter value', async () => {
    const audit = recordingAudit();
    const { gate } = harness({ seams: { audit } });
    await gate.run(gateRequest({ params: { key: 'UNIQUE-PARAMETER-VALUE-8841' } }));
    expect(audit.events).toEqual([expectedEvent('test.read', 'success')]);
    expect(JSON.stringify(audit.events)).not.toContain('UNIQUE-PARAMETER-VALUE-8841');
  });

  it('computes the request deadline from the clock and the request timeout', async () => {
    const clock = fakeClock(5000);
    const { gate, executor } = harness({ clock: clock.now });
    await gate.run(gateRequest());
    expect(executor.calls[0]?.deadlineAt).toBe(5000 + 10_000);
  });
});
