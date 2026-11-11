import { describe, expect, it } from 'vitest';
import { RETENTION_DEFAULTS } from '../mapping/retention.js';
import { Doc } from '../testing/doc.js';

const readme = new Doc('README.md');
const flat = readme.text.replace(/\s+/g, ' ');

describe('the retention figures in the README', () => {
  it('are the defaults of the product', () => {
    expect(flat).toContain(`"Deleted ones stay restorable for ${RETENTION_DEFAULTS.deletedInvestigationsDays} days."`);
    expect(flat).toContain(`A file is kept for ${RETENTION_DEFAULTS.exportsDays} days`);
  });

  it('link to the page that explains the settings, and the anchor exists', () => {
    const links = readme.links().filter((link) => link.target === 'docs/configuration.md#retention');
    expect(links).toHaveLength(2);
    for (const link of links) {
      const resolved = readme.resolveLink(link.target);
      expect([resolved.exists, resolved.anchorFound]).toEqual([true, true]);
    }
  });
});
