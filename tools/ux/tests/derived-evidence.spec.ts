import { expect, test, type Page } from '@playwright/test';
import { announcement, canvasOf, menuOf } from './support/workspace.ts';
import { boxOf } from './support/regions.ts';

const inspector = (page: Page) => page.getByRole('complementary', { name: 'Inspector' });
const panel = (page: Page) => page.getByRole('complementary', { name: 'Relationship evidence' });
const SOURCE = 'banking-demo';
const ref = (stableId: string) => ({ sourceId: SOURCE, entityType: 'account', stableId });

const node = (stableId: string) => ({
  ref: ref(stableId),
  display: { title: `Account ${stableId}`, type: 'account' },
  properties: [],
  qualityFlags: [],
  provenanceRefs: [],
  authorization: { canInspect: true, canExport: true },
});

const derivedEdge = {
  ref: { sourceId: SOURCE, derived: { ruleId: 'shared-device', from: ref('one-1'), to: ref('acc-2') } },
  from: ref('one-1'),
  to: ref('acc-2'),
  type: 'shared-device',
  direction: 'from-to',
  semantics: 'derived',
  derivation: { ruleId: 'shared-device', ruleVersion: 3, supportingEdgeRefs: [] },
  properties: [],
  evidenceRefs: [],
  qualityFlags: [],
};

const end = (stableId: string, type = 'account') => ({ ref: { ...ref(stableId), entityType: type }, title: `${type === 'account' ? 'Account' : 'Device'} ${stableId}`, type });
const support = (id: string, from: string, to: string, records: readonly string[]) => ({
  ref: { sourceId: SOURCE, type: 'USES_DEVICE', from: 'account', to: 'device', stableId: id },
  type: 'USES_DEVICE',
  from: end(from),
  to: end(to, 'device'),
  evidence: records.length === 0 ? { status: 'not-available', code: 'EVIDENCE_NOT_AVAILABLE' } : { status: 'available', records: records.map((sourceRecordId) => ({ sourceRecordId, linkable: false })) },
});
const detail = {
  ref: derivedEdge.ref,
  type: 'shared-device',
  semantics: 'derived',
  rule: { id: 'shared-device', version: 3 },
  from: end('one-1'),
  to: end('acc-2'),
  supports: {
    count: { value: 2, quality: 'exact', scope: 'derived:supports' },
    groups: [
      { middle: [end('dev-884', 'device')], supports: [support('r1', 'one-1', 'dev-884', ['AUTH-77102', 'AUTH-77119']), support('r2', 'acc-2', 'dev-884', ['AUTH-77140'])] },
      { middle: [end('dev-217', 'device')], supports: [support('r3', 'one-1', 'dev-217', []), support('r4', 'acc-2', 'dev-217', ['AUTH-77152'])] },
    ],
  },
  qualityFlags: [],
  warnings: [],
};

async function openWithDerived(page: Page): Promise<void> {
  await page.route((url) => url.pathname === '/v1/graph/preview-expansion', async (route) => {
    const body = route.request().postDataJSON() as { sourceId: string; ref: { entityType: string; stableId: string } };
    const total = { value: 1, quality: 'exact', scope: 'relationships' };
    await route.fulfill({ json: { ref: { sourceId: body.sourceId, ...body.ref }, total, byType: [], byNeighborType: [{ entityType: 'device', count: total }], warnings: [], pageSize: 25, heavyOpThreshold: 500 } });
  });
  await page.route((url) => url.pathname === '/v1/graph/derived-neighbors', async (route) => {
    const body = route.request().postDataJSON() as { sourceId: string; ref: { entityType: string; stableId: string } };
    await route.fulfill({ json: { ref: { sourceId: body.sourceId, ...body.ref }, results: [{ ruleId: 'shared-device', ruleVersion: 3, count: { value: 1, quality: 'exact', scope: 'derived:neighbors' }, nodes: [node('acc-2')], edges: [derivedEdge], warnings: [] }] } });
  });
  await page.route((url) => url.pathname.startsWith('/v1/edges/'), async (route) => route.fulfill({ json: detail }));
  await page.goto(`/${SOURCE}/entity/account/one-1`);
  await expect(page).toHaveURL(/\/explore\/[0-9a-f-]{36}$/);
  await expect(canvasOf(page)).toBeVisible();
  await canvasOf(page).focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Space');
  await expect(inspector(page)).toBeVisible();
  const show = inspector(page).getByRole('button', { name: /^Show Account \(shared-device\)/ });
  await show.focus();
  await page.keyboard.press('Enter');
  await expect(announcement(page)).toHaveText('1 neighbor added');
}

const SIZES = [
  { width: 1440, height: 900 },
  { width: 1280, height: 720 },
] as const;

async function expectNoOverlap(page: Page): Promise<void> {
  const [dock, card] = [await boxOf(panel(page)), await boxOf(inspector(page))];
  expect(dock.x >= card.x + card.width || card.x >= dock.x + dock.width || dock.y >= card.y + card.height || card.y >= dock.y + dock.height).toBe(true);
}

for (const size of SIZES) {
  test.describe(`the evidence of a derived relationship at ${size.width} × ${size.height}`, () => {
    test('opens by keyboard from the Evidence tab of the inspector, shows the rule, the sentence, the grouped supports and No confidence score, overlaps nothing, and Esc closes it', async ({ page }) => {
      await page.setViewportSize(size);
      await openWithDerived(page);
      await inspector(page).getByRole('tab', { name: 'Evidence' }).click();
      const row = inspector(page).getByRole('button', { name: /^shared-device, Account acc-2/ });
      await row.focus();
      await page.keyboard.press('Enter');
      await expect(panel(page)).toBeVisible();
      await expect(panel(page).getByText('Derived relationship')).toBeVisible();
      await expect(panel(page).getByText(/^Derived by rule shared-device \(version 3\)\. Account one-1 and Account acc-2 are linked through the shared .* shown below\.$/)).toBeVisible();
      await expect(panel(page).getByText('2 groups · exact')).toBeVisible();
      await expect(panel(page).getByText(/dev-884/).first()).toBeVisible();
      await expect(panel(page).getByText('AUTH-77102, AUTH-77119')).toBeVisible();
      await expect(panel(page).getByText('Evidence not available')).toBeVisible();
      await expect(panel(page).getByText('No confidence score')).toBeVisible();
      await expectNoOverlap(page);
      await page.keyboard.press('Escape');
      await expect(panel(page)).toHaveCount(0);
    });

    test('opens by keyboard alone from the relationship menu on the selected derived relationship, and overlaps nothing', async ({ page }) => {
      await page.setViewportSize(size);
      await openWithDerived(page);
      await canvasOf(page).focus();
      await page.keyboard.press('Enter');
      for (let step = 0; step < 40; step += 1) {
        if (((await announcement(page).textContent()) ?? '').startsWith('shared-device')) break;
        await page.keyboard.press('Tab');
      }
      await page.keyboard.press('Space');
      await page.keyboard.press('ContextMenu');
      await expect(menuOf(page)).toHaveCount(1);
      await expect(menuOf(page).getByRole('menuitem').first()).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(panel(page)).toBeVisible();
      await expect(panel(page).getByText('No confidence score')).toBeVisible();
      await expect(panel(page).getByRole('tab', { name: 'Evidence' })).toBeFocused();
      await expectNoOverlap(page);
      await panel(page).getByRole('tab', { name: 'Properties' }).click();
      await expect(panel(page).getByText('shared-device').first()).toBeVisible();
    });
  });
}
