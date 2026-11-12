import { expect, type Locator, type Page } from '@playwright/test';
import { openWithDerived } from './derived-stub.ts';
import { announcement, canvasOf, menuOf, openSample, screenOf } from './workspace.ts';

/**
 * The scripted cases of "can I trust this relationship?": a person selects an entity, reads its inspector, opens the evidence of a relationship, and reads why it is there, from the inspector and the
 * evidence panel alone. A case is written in what a person sees and does (roles, names, keys), never in how the page is built, and it runs in an *environment* that says how to reach each kind of
 * relationship. This repository runs them in three environments (the development sample, the sample with record links, and a stubbed API); a later end-to-end test imports `TRUST_CASES` and brings an environment over a real demo graph.
 */
export type RelationshipKind = 'stored-with-evidence' | 'stored-without-evidence' | 'derived' | 'aggregate';

/** How a person reaches the evidence of a relationship. */
export type Way = 'menu-by-pointer' | 'menu-by-keyboard' | 'inspector-row';

export interface Reach {
  readonly kind: RelationshipKind;
  readonly way: Way;
  /** Does what a person does to ask for the evidence of the relationship, up to the panel being asked for (not yet awaited). */
  readonly open: (page: Page) => Promise<void>;
  /** For the way `inspector-row`: the row of the inspector's Evidence tab that is asked, and that gets the focus back on Esc. */
  readonly row?: (page: Page) => Locator;
  /** For a relationship whose records can be opened: the link of its first record in the panel. */
  readonly record?: (page: Page) => Locator;
  /** What the panel shows for it, as visible text. */
  readonly shows: readonly (string | RegExp)[];
  /** Whether the panel says the evidence is not available (an ordinary state, never an alert). */
  readonly notAvailable?: boolean;
}

export interface TrustEnvironment {
  readonly name: string;
  /** Opens the workspace with an entity selected and its inspector open. */
  readonly openEntity: (page: Page) => Promise<void>;
  /** For `inspector-row` ways: the row that stays focused and gets the focus back on Esc. */
  readonly reaches: readonly Reach[];
}

export const inspectorOf = (page: Page): Locator => page.getByRole('complementary', { name: 'Inspector' });
export const evidenceOf = (page: Page): Locator => page.getByRole('complementary', { name: 'Relationship evidence' });

/** What no screen of the epic may show: an element ID of the source's database, or an address of a source record. */
export const NEVER_SHOWN: readonly RegExp[] = [/\b\d+:[0-9a-f-]{8,}:\d+\b/, /https?:\/\//];
/** The graph word a person must not read where the product means a relationship. */
export const GRAPH_WORD = /\bedges?\b/i;

export interface TrustCase {
  readonly id: string;
  readonly title: string;
  /** What a person does and sees, in a sentence each, for the people who read the list. */
  readonly steps: readonly string[];
  readonly run: (page: Page, environment: TrustEnvironment) => Promise<void>;
}

async function rightClickBetween(page: Page, from: string, to: string): Promise<void> {
  const a = await screenOf(page, from);
  const b = await screenOf(page, to);
  await page.mouse.click((a.x + b.x) / 2, (a.y + b.y) / 2, { button: 'right' });
  await expect(menuOf(page)).toHaveCount(1);
}

async function walkTo(page: Page, type: string): Promise<void> {
  await canvasOf(page).focus();
  await page.keyboard.press('Enter');
  for (let step = 0; step < 40; step += 1) {
    if (((await announcement(page).textContent()) ?? '').startsWith(type)) return;
    await page.keyboard.press('Tab');
  }
  throw new Error('NEVER_REACHED_BY_THE_WALK');
}

const WHY = /Why is this relationship here/;
const chooseWhy = (page: Page) => menuOf(page).getByRole('menuitem', { name: WHY }).click();

/** The development sample: ten entities, a relationship with a record, a relationship with none, one whose first read fails. */
export const sampleEnvironment: TrustEnvironment = {
  name: 'sample',
  openEntity: async (page) => {
    await openSample(page, '?evidence=on');
    const at = await screenOf(page, 'led-1');
    await page.mouse.click(at.x, at.y);
    await expect(inspectorOf(page)).toBeVisible();
  },
  reaches: [
    {
      kind: 'stored-with-evidence',
      way: 'menu-by-pointer',
      open: async (page) => {
        await rightClickBetween(page, 'holder', 'led-1');
        await chooseWhy(page);
      },
      shows: ['REC-1', 'REC-2'],
    },
    {
      kind: 'stored-with-evidence',
      way: 'menu-by-keyboard',
      open: async (page) => {
        await walkTo(page, 'HAS_LINE');
        await page.keyboard.press('Space');
        await page.keyboard.press('ContextMenu');
        await expect(menuOf(page)).toHaveCount(1);
        await page.keyboard.press('Enter');
      },
      shows: ['REC-sample-r-0'],
    },
    {
      kind: 'stored-with-evidence',
      way: 'inspector-row',
      row: (page) => inspectorOf(page).getByRole('button', { name: /^SENDS,/ }),
      open: async (page) => {
        await inspectorOf(page).getByRole('tab', { name: 'Evidence' }).click();
        await inspectorOf(page).getByRole('button', { name: /^SENDS,/ }).focus();
        await page.keyboard.press('Enter');
      },
      shows: ['REC-sample-r-4'],
    },
    {
      kind: 'aggregate',
      way: 'menu-by-pointer',
      open: async (page) => {
        await rightClickBetween(page, 'led-1', 'gad-1');
        await chooseWhy(page);
      },
      shows: ['Aggregate relationship', 'Members 57 · exact', 'Sample · first 3 by most recent observed time', '… 54 more in this sample. There is no paging.'],
    },
    {
      kind: 'aggregate',
      way: 'menu-by-keyboard',
      open: async (page) => {
        await walkTo(page, 'USES_GADGET');
        await page.keyboard.press('Space');
        await page.keyboard.press('ContextMenu');
        await expect(menuOf(page)).toHaveCount(1);
        await page.keyboard.press('Enter');
      },
      shows: ['Aggregate relationship', 'Members 57 · exact'],
    },
    {
      kind: 'stored-without-evidence',
      way: 'menu-by-pointer',
      open: async (page) => {
        await rightClickBetween(page, 'holder', 'cas');
        await chooseWhy(page);
      },
      shows: ['Evidence not available', 'The source holds no record for this relationship.'],
      notAvailable: true,
    },
  ],
};

/** A stubbed API with a rule-derived relationship of two groups of supports, one of them without retained records. */
export const derivedEnvironment: TrustEnvironment = {
  name: 'derived',
  openEntity: openWithDerived,
  reaches: [
    {
      kind: 'derived',
      way: 'inspector-row',
      row: (page) => inspectorOf(page).getByRole('button', { name: /^shared-device, Account acc-2/ }),
      open: async (page) => {
        await inspectorOf(page).getByRole('tab', { name: 'Evidence' }).click();
        await inspectorOf(page).getByRole('button', { name: /^shared-device, Account acc-2/ }).focus();
        await page.keyboard.press('Enter');
      },
      shows: ['Derived relationship', /Derived by rule shared-device \(version 3\)\./, '2 groups · exact', 'AUTH-77102, AUTH-77119', 'Evidence not available', 'No confidence score'],
    },
    {
      kind: 'derived',
      way: 'menu-by-keyboard',
      open: async (page) => {
        await walkTo(page, 'shared-device');
        await page.keyboard.press('Space');
        await page.keyboard.press('ContextMenu');
        await expect(menuOf(page)).toHaveCount(1);
        await page.keyboard.press('Enter');
      },
      shows: ['Derived relationship', 'No confidence score'],
    },
  ],
};

/** The development sample with source record links on: the HAS_LINE relationship has a record that can be opened. */
export const linkedSampleEnvironment: TrustEnvironment = {
  name: 'sample with record links',
  openEntity: async (page) => {
    await openSample(page, '?evidence=on&links=on');
    const at = await screenOf(page, 'led-1');
    await page.mouse.click(at.x, at.y);
    await expect(inspectorOf(page)).toBeVisible();
  },
  reaches: [
    {
      kind: 'stored-with-evidence',
      way: 'menu-by-keyboard',
      open: async (page) => {
        await walkTo(page, 'HAS_LINE');
        await page.keyboard.press('Space');
        await page.keyboard.press('ContextMenu');
        await expect(menuOf(page)).toHaveCount(1);
        await menuOf(page).getByRole('menuitem', { name: WHY }).focus();
        await page.keyboard.press('Enter');
      },
      record: (page) => evidenceOf(page).getByRole('link', { name: /REC-/ }).first(),
      shows: ['REC-sample-r-0'],
    },
  ],
};

export const ENVIRONMENTS: readonly TrustEnvironment[] = [sampleEnvironment, derivedEnvironment, linkedSampleEnvironment];

/** The text of the evidence panel and, when it is open beside the panel (an entity is selected), of the inspector. */
const texts = async (page: Page): Promise<string> => {
  const inspector = (await inspectorOf(page).count()) === 0 ? '' : ((await inspectorOf(page).textContent()) ?? '');
  return `${inspector}\n${(await evidenceOf(page).textContent()) ?? ''}`;
};

async function openAndAwait(page: Page, reach: Reach): Promise<void> {
  await reach.open(page);
  await expect(evidenceOf(page)).toBeVisible();
}

export const TRUST_CASES: readonly TrustCase[] = [
  {
    id: 'entity-inspector',
    title: 'An entity opens an inspector that is read, left and closed from the keyboard',
    steps: ['Select an entity', 'Its inspector shows Overview, Relationships and Properties', 'Esc closes it and the canvas has the focus again'],
    run: async (page, environment) => {
      await environment.openEntity(page);
      await expect(inspectorOf(page).getByRole('tab', { name: 'Overview' })).toBeVisible();
      await expect(inspectorOf(page).getByRole('tab', { name: 'Relationships' })).toBeVisible();
      await expect(inspectorOf(page).getByRole('tab', { name: 'Properties' })).toBeVisible();
      await inspectorOf(page).getByRole('tab', { name: 'Overview' }).focus();
      await page.keyboard.press('Escape');
      await expect(inspectorOf(page)).toHaveCount(0);
      await expect(canvasOf(page)).toBeFocused();
    },
  },
  {
    id: 'evidence-panel',
    title: 'Each kind of relationship answers "why is this relationship here?" in the evidence panel',
    steps: ['Ask for the evidence of a relationship by every way a person has', 'The panel names the question, shows the tabs Evidence, Properties and Source, and the evidence of the kind', 'A kind with no retained records says so as an ordinary state, with no alert'],
    run: async (page, environment) => {
      for (const reach of environment.reaches) {
        await environment.openEntity(page);
        await openAndAwait(page, reach);
        await expect(evidenceOf(page).getByRole('heading', { name: 'Relationship evidence' }), `${reach.kind} by ${reach.way}`).toBeVisible();
        await expect(evidenceOf(page).getByRole('tab')).toHaveText(['Evidence', 'Properties', 'Source']);
        if (reach.kind === 'aggregate') await expect(evidenceOf(page).getByText('Aggregate relationship').first()).toBeVisible();
        else if (reach.kind === 'derived') await expect(evidenceOf(page).getByText('Derived relationship').first()).toBeVisible();
        else await expect(evidenceOf(page).getByRole('heading', { name: 'Why is this relationship here?' })).toBeVisible();
        // the text is read once the heading is there, so that a missing field is a failed comparison and not a wait
        const text = await evidenceOf(page).innerText();
        for (const shown of reach.shows) {
          if (typeof shown === 'string') expect(text, `${reach.kind} by ${reach.way}`).toContain(shown);
          else expect(text, `${reach.kind} by ${reach.way}`).toMatch(shown);
        }
        if (reach.notAvailable === true) await expect(evidenceOf(page).getByRole('alert')).toHaveCount(0);
      }
    },
  },
  {
    id: 'keyboard-and-focus',
    title: 'The evidence panel takes the focus on its Evidence tab and gives it back on Esc',
    steps: ['Ask for the evidence', 'The Evidence tab of the panel has the focus', 'Esc closes the panel; the focus is on the row or the canvas it came from'],
    run: async (page, environment) => {
      for (const reach of environment.reaches) {
        await environment.openEntity(page);
        await openAndAwait(page, reach);
        await expect(evidenceOf(page).getByRole('tab', { name: 'Evidence' }), `${reach.kind} by ${reach.way}`).toBeFocused();
        await page.keyboard.press('Escape');
        await expect(evidenceOf(page)).toHaveCount(0);
        if (reach.row !== undefined) await expect(reach.row(page)).toBeFocused();
        else await expect(canvasOf(page)).toBeFocused();
      }
    },
  },
  {
    id: 'source-record',
    title: 'A record that can be opened is a link to the application\'s own path, reached by the keyboard, and the focus is kept',
    steps: ['Ask for the evidence of a relationship whose record has a link', 'Tab reaches the record link; it goes to the application (/v1/source-links/…?record=), in a new tab, never to the source', 'Esc closes the panel and the focus is back on the canvas'],
    run: async (page, environment) => {
      for (const reach of environment.reaches.filter((each) => each.record !== undefined)) {
        await environment.openEntity(page);
        await openAndAwait(page, reach);
        const link = (reach.record as NonNullable<Reach['record']>)(page);
        await expect(link).toBeVisible();
        await link.focus();
        await expect(link).toBeFocused();
        expect(await link.getAttribute('href'), 'the link goes to the application, with the record').toMatch(/^\/v1\/source-links\/[^?]+\?(.*&)?record=REC-/);
        expect(await link.getAttribute('target')).toBe('_blank');
        expect(await link.getAttribute('rel')).toContain('noopener');
        await page.keyboard.press('Escape');
        await expect(evidenceOf(page)).toHaveCount(0);
        await expect(canvasOf(page)).toBeFocused();
      }
    },
  },
  {
    id: 'nothing-private-on-screen',
    title: 'No element ID of the source and no address of a source record is on the screen',
    steps: ['Ask for the evidence of every kind', 'The inspector and the panel hold no element ID of the source database and no http address'],
    run: async (page, environment) => {
      for (const reach of environment.reaches) {
        await environment.openEntity(page);
        await openAndAwait(page, reach);
        const text = await texts(page);
        for (const pattern of NEVER_SHOWN) expect(text, `${reach.kind} by ${reach.way}`).not.toMatch(pattern);
        const hrefs = await page.locator('aside a[href]').evaluateAll((links) => links.map((link) => link.getAttribute('href') ?? ''));
        for (const href of hrefs) expect(href, 'a link in the inspector or the panel goes to the application, never to the source').toMatch(/^(\/|#)/);
      }
    },
  },
  {
    id: 'says-relationship',
    title: 'The screen says "relationship" and never the graph word',
    steps: ['Ask for the evidence of every kind', 'The words on the screen name a relationship; the graph word "edge" is nowhere'],
    run: async (page, environment) => {
      for (const reach of environment.reaches) {
        await environment.openEntity(page);
        await openAndAwait(page, reach);
        const text = await texts(page);
        expect(text, `${reach.kind} by ${reach.way}`).toMatch(/relationship/i);
        expect(text, `${reach.kind} by ${reach.way}`).not.toMatch(GRAPH_WORD);
      }
    },
  },
];
