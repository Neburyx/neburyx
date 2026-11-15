import { describe, expect, it } from 'vitest';
import { sampleExportClient } from './sample-client.js';

const REF = { sourceId: 'frame-sample', entityType: 'holder', stableId: 'h-1' };

describe('the sample\'s export answers', () => {
  it('answers a picture with a header that counts the references it was sent', async () => {
    const answer = await sampleExportClient().createExport('id', { kind: 'view', format: 'png', mask: false, entities: [REF, { ...REF, stableId: 'h-2' }], edges: [], aggregates: [], derived: [] }, 'k'.repeat(16));
    expect(answer.ok && 'header' in answer.value ? answer.value.header.coverage.shown : undefined).toBe(2);
  });

  it('refuses a file format', async () => {
    const answer = await sampleExportClient().createExport('id', { kind: 'view', format: 'json', entities: [], edges: [], aggregates: [], derived: [] }, 'k'.repeat(16));
    expect(answer.ok).toBe(false);
  });
});
