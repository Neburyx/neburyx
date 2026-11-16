import { renderForExport } from '@neburyx/ee-ask';
import { describe, expect, it } from 'vitest';
import { edge, node, prop, reading } from './view.js';
import { INVESTIGATION, KEYS, replyOf, startRig } from './testing/rig.js';

const account = node('account', 'AC-1', 'Ana Silva', [prop('status', 'open')]);
const device = node('device', 'DV-1', 'Phone DV-1');
const uses = edge('USES_DEVICE', 'r1', account.ref, device.ref);
const view = reading([account, device], [uses]);

/** A token from the whole click over a scripted model, then rendered for an export of the given reading. */
async function exported(text: string, cites: readonly string[], forExport = view) {
  const rig = startRig({ replies: [replyOf({ text, cites })] });
  const outcome = await rig.summarize(view);
  if (outcome.status !== 'ok' && outcome.status !== 'partial') throw new Error(`the click did not answer: ${outcome.status}`);
  const answered = renderForExport(KEYS, { token: outcome.summaryToken, investigationId: INVESTIGATION, actorId: 'analyst-1', policyVersion: 'policy-1', reading: forExport }, Date.now());
  return answered.status === 'ok' ? answered.section.sentences.map((sentence) => sentence.text) : ['REFUSED'];
}

describe('the summary of an export, from a token of a whole click', () => {
  it('keeps the sentence for an export that holds what it rests on (the control of every drop below)', async () => {
    expect(await exported('AC-1 uses the device DV-1.', ['n1', 'n2', 'e1'])).toEqual(['AC-1 uses the device DV-1.']);
  });

  it('drops it when the export holds no longer the elements it cites', async () => {
    expect(await exported('AC-1 uses the device DV-1.', ['n1', 'n2', 'e1'], reading([account]))).toEqual([]);
  });

  it('drops it when it names an element the export does not hold, though it cites another', async () => {
    expect(await exported('AC-1 uses the device DV-1.', ['n1', 'e1'], reading([account]))).toEqual([]);
  });

  it('drops it when the value it quotes is masked in the export', async () => {
    const masked = node('account', 'AC-1', 'Ana Silva', [prop('status', 'o•••', true)]);
    expect(await exported('AC-1 has the status "open".', ['n1'], reading([account, device]))).toEqual(['AC-1 has the status "open".']);
    expect(await exported('AC-1 has the status "open".', ['n1'], reading([masked, device]))).toEqual([]);
  });
});
