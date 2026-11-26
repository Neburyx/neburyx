import { createEnterpriseExtension } from '@neburyx/ee-ask';
import { summaryResponseSchema } from '@neburyx/contracts';
import { afterAll, describe, expect, it } from 'vitest';
import { el, exportWebRoot, startExportRig } from '../../../services/api/src/testing/export-rig.js';
import { rmSync } from 'node:fs';
import { countRuleBroken, expectEachIdOnce, expectNoText, expectSameText, keysOfSentText, SuiteCheckFailed } from './checks.js';
import { keyMapOf, loadCases, readingOf } from './cases.js';
import { replyOf, startRig } from './testing/rig.js';
import { edge, node, prop, reading } from './view.js';

afterAll(() => rmSync(exportWebRoot, { recursive: true, force: true }));

const set = loadCases();
const okReply = replyOf({ text: 'One element is listed.', cites: ['n1'] });

describe('what the model is sent: the text of the elements, written by hand', () => {
  it('is, for a view of two entities and a stored relationship, exactly the expected text, which is also the disclosure', async () => {
    const account = node('account', 'AC-1', 'Ana Silva', [prop('status', 'open'), prop('tier', 'gold')]);
    const device = node('device', 'DV-1', 'Phone');
    const rig = startRig({ replies: [okReply] });
    const outcome = await rig.summarize(reading([device, account], [edge('USES_DEVICE', 'r1', account.ref, device.ref, { observedAt: '2026-01-02', properties: [prop('channel', 'app')] })]));
    const expected = [
      'Entities:',
      'n1 | "account" | title: "Ana Silva" | id: "AC-1" | status: "open"; tier: "gold"',
      'n2 | "device" | title: "Phone" | id: "DV-1"',
      'Relationships:',
      'e1 | "USES_DEVICE" | n1 -> n2 | stored | observed at "2026-01-02" | channel: "app"',
    ].join('\n');
    expect(rig.requests).toHaveLength(1);
    expectSameText(rig.requests[0]?.values ?? '', expected);
    expect(outcome.status === 'ok' && outcome.sent).toBe(expected);
  });

  it('is, for a view with a masked value, an aggregate with an estimated count, a derived relationship, an end not read and a reference not read, exactly the expected text', async () => {
    const account = node('account', 'AC-1', 'AC-1', [prop('phone', '***-1234', true), { key: 'note', dataClass: 'text', masked: true }]);
    const other = node('account', 'AC-2', 'AC-2');
    const aggregate = edge('TRANSFERRED_TO', 'agg', account.ref, other.ref, {
      ref: { sourceId: 'demo', aggregate: { type: 'TRANSFERRED_TO', from: account.ref, to: other.ref } },
      memberCount: { value: 40, quality: 'estimated', scope: 'coverage' },
      observedFirst: '2026-02-01',
      observedLast: '2026-02-09',
    });
    const derived = edge('SHARES_DEVICE', 'rule', account.ref, other.ref, {
      ref: { sourceId: 'demo', derived: { ruleId: 'shared-device', from: account.ref, to: other.ref } },
      semantics: 'derived',
      derivation: { ruleId: 'shared-device', ruleVersion: 2, supportingEdgeRefs: [] },
    });
    const unread = edge('PAID_TO', 'r9', other.ref, { sourceId: 'demo', entityType: 'merchant', stableId: 'MR-9' });
    const rig = startRig({ replies: [okReply] });
    const outcome = await rig.summarize(reading([account, other], [aggregate, derived, unread], { unresolved: 2 }));
    const expected = [
      'Entities:',
      'n1 | "account" | title: "AC-1" | id: "AC-1" | phone: "***-1234" (masked); note: (not shown)',
      'n2 | "account" | title: "AC-2" | id: "AC-2"',
      'Relationships:',
      'e1 | "TRANSFERRED_TO" | n1 -> n2 | stored | observed "2026-02-01" to "2026-02-09" | relationships between them: ~40 (estimated)',
      'e2 | "SHARES_DEVICE" | n1 -> n2 | derived | derived by rule "shared-device" version 2',
      'e3 | "PAID_TO" | n2 -> an end that was not read ("merchant" "MR-9") | stored',
      '2 references could not be read.',
    ].join('\n');
    expectSameText(rig.requests[0]?.values ?? '', expected);
    expect(outcome.status === 'ok' && outcome.sent).toBe(expected);
  });

  it.each([
    [{ value: 40, quality: 'estimated', scope: 'coverage' }, '~40 (estimated)', '40 transfers are listed.'],
    [{ value: 40, quality: 'lowerBound', scope: 'coverage' }, '≥ 40 (lower bound)', '40 transfers are listed.'],
    [{ quality: 'unknown', scope: 'coverage' }, 'not known', '40 transfers are listed.'],
  ] as const)('writes a count the suite’s count check reads: %o', async (memberCount, phrase, bare) => {
    const account = node('account', 'AC-1', 'AC-1');
    const other = node('account', 'AC-2', 'AC-2');
    const aggregate = edge('TRANSFERRED_TO', 'agg', account.ref, other.ref, { ref: { sourceId: 'demo', aggregate: { type: 'TRANSFERRED_TO', from: account.ref, to: other.ref } }, memberCount });
    const rig = startRig({ replies: [okReply] });
    await rig.summarize(reading([account, other], [aggregate]));
    const sent = rig.requests[0]?.values ?? '';
    // the line the product wrote: a check that no longer recognises it would pass every sentence
    expect(sent).toContain(phrase);
    expect(countRuleBroken({ text: bare, cites: ['e1'] }, sent)).toBe(true);
    expect(countRuleBroken({ text: 'The transfers are listed.', cites: ['e1'] }, sent)).toBe(false);
  });

  it('canary: a text that drops a field, one that sends an element twice and one that adds a withheld value each fail the comparison', () => {
    const expected = 'Entities:\nn1 | "account" | title: "A" | id: "AC-1" | status: "open"\nRelationships:\n(none)';
    expect(() => expectSameText(expected.replace(' | status: "open"', ''), expected)).toThrow(SuiteCheckFailed);
    const twice = expected.replace('Relationships:', 'n2 | "account" | title: "A" | id: "AC-1"\nRelationships:');
    expect(() => expectEachIdOnce(twice, ['AC-1'])).toThrow(SuiteCheckFailed);
    expect(() => expectEachIdOnce(expected, ['AC-1'])).not.toThrow();
    expect(() => expectNoText([{ values: `${expected}\nSENTINEL-WITHHELD` }], ['SENTINEL-WITHHELD'])).toThrow(SuiteCheckFailed);
  });
});

describe('what the model is sent: every view of the set', () => {
  it('holds in its instructions no element text, and sends every element once under its own key', async () => {
    for (const labelled of set.cases) {
      const rig = startRig({ replies: [okReply] });
      await rig.summarize(readingOf(labelled));
      const request = rig.requests[0];
      const sent = request?.values ?? '';
      for (const entity of labelled.entities) {
        expect(request?.instructions ?? '', `${labelled.id}: ${entity.id}`).not.toContain(entity.id);
        expect(request?.instructions ?? '', `${labelled.id}: ${entity.name}`).not.toContain(entity.name);
      }
      expectEachIdOnce(sent, labelled.entities.map((entity) => entity.id));
      expect(keyMapOf(labelled, sent).size, labelled.id).toBe(labelled.entities.length + labelled.relationships.length);
      expect(keysOfSentText(sent).size, labelled.id).toBe(labelled.entities.length + labelled.relationships.length);
    }
  });
});

describe('what the model is sent: an element that was not read', () => {
  it('sends the type and id of an end the gate returned on a relationship, gives it no key, and removes a sentence that cites it', async () => {
    const account = node('account', 'AC-1', 'AC-1');
    const rig = startRig({ replies: [replyOf({ text: 'The account paid a merchant.', cites: ['n1', 'e1'] }, { text: 'The merchant MR-9 is listed.', cites: ['n2'] })], settings: { maxCalls: 1 } });
    const outcome = await rig.summarize(reading([account], [edge('PAID_TO', 'r9', account.ref, { sourceId: 'demo', entityType: 'merchant', stableId: 'MR-9' })]));
    const sent = rig.requests[0]?.values ?? '';
    expect(sent).toContain('an end that was not read ("merchant" "MR-9")');
    expect(keysOfSentText(sent)).toEqual(new Set(['n1', 'e1']));
    expect(outcome.status).toBe('partial');
    expect(outcome.status === 'partial' && outcome.sentences.map((sentence) => sentence.text)).toEqual(['The account paid a merchant.']);
  });
});

describe('what the model is sent through the real application and the real gate', () => {
  async function app(options: { readonly widgets?: readonly string[]; readonly hideNode?: string; readonly name?: (id: string) => string } = {}) {
    const rig = startRig({ replies: [okReply], settings: { maxCalls: 1 } });
    const exports = await startExportRig({ extension: createEnterpriseExtension(), caseSummarizer: rig.summarizer, ...options });
    const investigation = await exports.open();
    const post = (ids: readonly string[], mask: boolean) =>
      exports.app.inject({
        method: 'POST',
        url: '/v1/summary',
        payload: { investigationId: investigation.id, sourceId: 'demo', entities: ids.map((id) => el('widget', id)), mask },
        headers: { 'idempotency-key': `key-${String(++keys).padStart(16, '0')}` },
      });
    return { rig, exports, post };
  }
  let keys = 0;

  it('sends a masked value as the analyst sees it on screen and the unmasked value to no request, no event and no response', async () => {
    const { rig, exports, post } = await app({ name: (id) => `SENTINEL-CLEAR-NAME-${id}` });
    const response = await post(['W-1', 'W-2'], true);
    expect(response.statusCode).toBe(200);
    const body = summaryResponseSchema.parse(response.json());
    const expected = [
      'Entities:',
      'n1 | "widget" | title: "S•••" | id: "W-1" | widgetId: "W-1"; ownerName: "S•••" (masked)',
      'n2 | "widget" | title: "S•••" | id: "W-2" | widgetId: "W-2"; ownerName: "S•••" (masked)',
      'Relationships:',
      '(none)',
    ].join('\n');
    expectSameText(rig.requests[0]?.values ?? '', expected);
    expect(body.status === 'ok' && body.sent).toBe(expected);
    expectNoText([rig.requests, rig.events, response.json(), exports.events], ['SENTINEL-CLEAR-NAME']);
    await exports.stop();
  });

  it('sends the names an analyst sees when the mask is off', async () => {
    const { rig, exports, post } = await app({ name: () => 'NAME-CLEAR' });
    const response = await post(['W-1'], false);
    expect(response.statusCode).toBe(200);
    expectSameText(rig.requests[0]?.values ?? '', ['Entities:', 'n1 | "widget" | title: "NAME-CLEAR" | id: "W-1" | widgetId: "W-1"; ownerName: "NAME-CLEAR"', 'Relationships:', '(none)'].join('\n'));
    await exports.stop();
  });

  it('sends nothing of an element the gate withheld or could not read: its name, its id and its property appear in no request, no event and no response', async () => {
    const { rig, exports, post } = await app({ widgets: ['W-1', 'SENTINEL-WITHHELD-ID'], hideNode: 'SENTINEL-WITHHELD-ID', name: (id) => (id === 'W-1' ? 'NAME-CLEAR' : 'SENTINEL-WITHHELD-NAME') });
    const response = await post(['W-1', 'SENTINEL-WITHHELD-ID', 'SENTINEL-UNRESOLVED-ID'], false);
    expect(response.statusCode).toBe(200);
    expectSameText(rig.requests[0]?.values ?? '', ['Entities:', 'n1 | "widget" | title: "NAME-CLEAR" | id: "W-1" | widgetId: "W-1"; ownerName: "NAME-CLEAR"', 'Relationships:', '(none)', '2 references could not be read.'].join('\n'));
    expectNoText([rig.requests, rig.events, response.json(), exports.events], ['SENTINEL-WITHHELD-NAME', 'SENTINEL-WITHHELD-ID', 'SENTINEL-UNRESOLVED-ID']);
    await exports.stop();
  });
});
