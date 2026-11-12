import { describe, expect, it } from 'vitest';
import { ACCESS_DENIED_ENTRIES } from './error-table.js';
import { ExtensionRefusal, parseExtensionRefusal, type ExtensionRequest } from './extension.js';

const fields = { code: 'ACCESS_DENIED', reason: 'ai-preview-off', audited: true } as const;

describe('the sentence of a call to an AI route while the preview is off', () => {
  it('says the preview is not switched on and that the switch is a safety rail, not a lock, and cannot be retried', () => {
    expect(ACCESS_DENIED_ENTRIES['ai-preview-off']).toEqual({
      message: 'The AI preview is not switched on for this deployment. The switch is a safety rail that whoever runs the deployment sets, not a lock.',
      retryable: false,
    });
  });

  it('leaves the two export reasons as they were', () => {
    expect(ACCESS_DENIED_ENTRIES['access-changed'].message).toBe('Your access changed since this export was made. Export again to get a file that matches your current access.');
    expect(ACCESS_DENIED_ENTRIES['export-source-changed'].retryable).toBe(false);
  });
});

describe('a refusal of an extension', () => {
  it('is an error carrying a fixed name, the code, the reason and whether its audit event was written, and no message of its own', () => {
    const refusal = new ExtensionRefusal({ ...fields, audited: false });
    expect(refusal).toBeInstanceOf(Error);
    expect(refusal.name).toBe('ExtensionRefusal');
    expect([refusal.code, refusal.reason, refusal.audited, refusal.message]).toEqual(['ACCESS_DENIED', 'ai-preview-off', false, '']);
  });

  it('names no other code or reason', () => {
    // @ts-expect-error a refusal names one code
    expect(() => new ExtensionRefusal({ ...fields, code: 'NOT_FOUND' })).not.toThrow();
    // @ts-expect-error a refusal names one reason
    expect(() => new ExtensionRefusal({ ...fields, reason: 'access-changed' })).not.toThrow();
  });
});

describe('recognising a refusal by its shape', () => {
  it('reads a refusal of this copy and a plain object or error of the same shape made by another copy', () => {
    expect(parseExtensionRefusal(new ExtensionRefusal(fields))).toEqual(fields);
    expect(parseExtensionRefusal({ name: 'ExtensionRefusal', ...fields })).toEqual(fields);
    const other = Object.assign(new Error(), { name: 'ExtensionRefusal', ...fields, audited: false });
    expect(parseExtensionRefusal(other)).toEqual({ ...fields, audited: false });
  });

  it.each([
    ['another code', { name: 'ExtensionRefusal', ...fields, code: 'NOT_FOUND' }],
    ['another reason', { name: 'ExtensionRefusal', ...fields, reason: 'access-changed' }],
    ['no audited mark', { name: 'ExtensionRefusal', code: 'ACCESS_DENIED', reason: 'ai-preview-off' }],
    ['an audited mark that is not a boolean', { name: 'ExtensionRefusal', ...fields, audited: 'yes' }],
    ['another name', { name: 'Error', ...fields }],
    ['an ordinary error', new Error('boom')],
    ['text', 'ExtensionRefusal'],
    ['nothing', undefined],
  ])('reads nothing from %s', (_name, value) => {
    expect(parseExtensionRefusal(value)).toBeUndefined();
  });
});

describe('the request an extension handler is given', () => {
  const complete: ExtensionRequest = { principalId: 'p', principalRole: 'investigator', previewOn: true, traceId: 'tr-1', audit: { record: async () => undefined } };

  it('is only added to: a handler that reads the principal alone still takes it', async () => {
    const handler = async (request: ExtensionRequest): Promise<string> => request.principalId;
    expect(await handler(complete)).toBe('p');
  });

  it('cannot be built without any of its five fields', () => {
    const { audit, ...withoutAudit } = complete;
    const { previewOn, ...withoutSwitch } = complete;
    const { principalRole, ...withoutRole } = complete;
    const { traceId, ...withoutTrace } = complete;
    const { principalId, ...withoutId } = complete;
    // @ts-expect-error the audit sink is required
    const noAudit: ExtensionRequest = withoutAudit;
    // @ts-expect-error the switch is required
    const noSwitch: ExtensionRequest = withoutSwitch;
    // @ts-expect-error the role is required
    const noRole: ExtensionRequest = withoutRole;
    // @ts-expect-error the trace ID is required
    const noTrace: ExtensionRequest = withoutTrace;
    // @ts-expect-error the principal ID is required
    const noId: ExtensionRequest = withoutId;
    expect([audit, previewOn, principalRole, traceId, principalId].every((field) => field !== undefined)).toBe(true);
    expect([noAudit, noSwitch, noRole, noTrace, noId]).toHaveLength(5);
  });
});
