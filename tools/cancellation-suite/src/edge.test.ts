import { afterEach, describe, expect, it } from 'vitest';
import { EDGE_REF, personalise, startRig, until, type Rig } from './rig.js';

let rig: Rig;
afterEach(async () => {
  await rig.close();
});

const slotsFree = (): boolean => rig.slots.inspect().sources.size === 0 && rig.slots.inspect().users.size === 0;

describe('reading the evidence of a stored edge', () => {
  it('answers the edge, reading nothing into the investigation', async () => {
    rig = await startRig();
    personalise(rig);
    const before = rig.snapshot();
    const asked = rig.client.getEdge(EDGE_REF);
    (await rig.nextRead()).answerRows();
    const result = await asked;
    expect(result).toMatchObject({ ok: true, value: { ref: EDGE_REF, evidence: { status: 'not-available', code: 'EVIDENCE_NOT_AVAILABLE' } } });
    expect(rig.snapshot()).toBe(before);
    await until(slotsFree, 'the read slots to be free');
  });

  it('leaves the client as it was when the person cancels, even when the source answers afterwards, aborts the read, audits it as cancelled and frees the slots', async () => {
    rig = await startRig();
    personalise(rig);
    const before = rig.snapshot();
    const controller = new AbortController();
    const asked = rig.client.getEdge(EDGE_REF, undefined, controller.signal);
    const read = await rig.nextRead();
    expect(read.call.signal?.aborted).toBe(false);
    controller.abort();
    await until(() => read.call.signal?.aborted === true, 'the read to be aborted');
    read.answerRows();
    expect(await asked).toEqual({ ok: false, failure: { code: 'ABORTED' } });
    await until(() => rig.events.some((event) => event.action === 'edge.load'), 'the audit event');
    expect(rig.events.find((event) => event.action === 'edge.load')).toMatchObject({ result: 'failed', detail: { reason: 'cancelled' } });
    expect(rig.snapshot()).toBe(before);
    await until(slotsFree, 'the read slots to be free');
    const next = rig.client.getEdge(EDGE_REF);
    (await rig.nextRead()).answerRows();
    expect(await next).toMatchObject({ ok: true });
  });

  it('answers QUERY_TIMEOUT with the source timeout, leaves the client as it was and frees the slots', async () => {
    rig = await startRig();
    personalise(rig);
    const before = rig.snapshot();
    const asked = rig.client.getEdge(EDGE_REF);
    (await rig.nextRead()).fail({ status: 'timeout' });
    expect(await asked).toMatchObject({ ok: false, failure: { code: 'QUERY_TIMEOUT', retryable: true, details: { timeoutMs: expect.any(Number) } } });
    expect(rig.snapshot()).toBe(before);
    await until(slotsFree, 'the read slots to be free');
  });

  it('answers SOURCE_UNAVAILABLE when the source stops answering, leaves the client as it was, and reads again when the source is back', async () => {
    rig = await startRig();
    personalise(rig);
    const before = rig.snapshot();
    const asked = rig.client.getEdge(EDGE_REF);
    (await rig.nextRead()).fail({ status: 'unavailable', reason: 'unreachable' });
    expect(await asked).toMatchObject({ ok: false, failure: { code: 'SOURCE_UNAVAILABLE', retryable: true } });
    expect(rig.snapshot()).toBe(before);
    await until(slotsFree, 'the read slots to be free');
    rig.drain();
    expect(await rig.client.getEdge(EDGE_REF)).toMatchObject({ ok: true });
  });
});
