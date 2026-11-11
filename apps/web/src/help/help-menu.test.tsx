import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { clientWith, me, renderApp, source } from '../test-utils.js';
import { createClientState } from '../state/client-state.js';
import { ClientStateProvider } from '../state/context.js';
import { builtInKeyBindings } from '../test-utils.js';
import { KeyBindingsProvider } from '../workspace/key-binding-registry.js';
import { HELP_ITEMS, type HelpItem } from './help-items.js';
import { HelpMenu } from './help-menu.js';
import { HELP_LINKS } from './links.js';

const ready = () => clientWith({ me: me(), sources: [source('a')] });
const helpButton = () => screen.getByRole('button', { name: 'Help' });

describe('the Help item', () => {
  it('is a menu button in the sidebar of the start page, below Sources and above the source line', async () => {
    renderApp('/', ready());
    const aside = screen.getByRole('complementary');
    const button = within(aside).getByRole('button', { name: 'Help' });
    expect(button.getAttribute('aria-haspopup')).toBe('menu');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    const links = within(aside).getAllByRole('link');
    const sources = links.at(-1);
    expect(sources?.compareDocumentPosition(button)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(button.compareDocumentPosition(within(aside).getByRole('region', { name: 'Source' }))).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it.each(['/investigations', '/sources', '/search'])('is not in the sidebar of %s', async (path) => {
    renderApp(path, ready());
    expect(await screen.findByRole('complementary')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Help' })).toBeNull();
  });
});

describe('the Help menu', () => {
  it('lists the five items in the order of the design, with the divider before the Enterprise item and the shortcut key on the first', async () => {
    renderApp('/', ready());
    await userEvent.click(helpButton());
    const menu = screen.getByRole('menu', { name: 'Help' });
    expect(within(menu).getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Keyboard shortcuts⌘/', 'Documentation↗', 'Quickstart: the demo case↗', 'Talk to us about Enterprise↗', 'Report a problem↗']);
    expect(helpButton().getAttribute('aria-expanded')).toBe('true');
    const separators = within(menu).getAllByRole('separator');
    expect(separators).toHaveLength(1);
    expect(separators[0]?.nextElementSibling?.textContent).toContain('Talk to us about Enterprise');
  });

  it('opens each of the four links in a new tab without the opener, and closes', async () => {
    renderApp('/', ready());
    const expected: Record<string, string> = {
      Documentation: HELP_LINKS.documentation,
      'Quickstart: the demo case': HELP_LINKS.quickstart,
      'Talk to us about Enterprise': HELP_LINKS.enterprise,
      'Report a problem': HELP_LINKS.problem,
    };
    for (const [name, href] of Object.entries(expected)) {
      await userEvent.click(helpButton());
      const link = screen.getByRole('menuitem', { name: new RegExp(`^${name}`) });
      expect(link.getAttribute('href')).toBe(href);
      expect(link.getAttribute('target')).toBe('_blank');
      expect(link.getAttribute('rel')?.split(' ').sort()).toEqual(['noopener', 'noreferrer']);
      link.addEventListener('click', (event) => event.preventDefault());
      await userEvent.click(link);
      expect(screen.queryByRole('menu')).toBeNull();
    }
  });

  it('closes on a press outside it and changes nothing else', async () => {
    renderApp('/', ready());
    await userEvent.click(helpButton());
    await userEvent.click(screen.getByRole('main'));
    expect(screen.queryByRole('menu')).toBeNull();
    expect(helpButton().getAttribute('aria-expanded')).toBe('false');
  });

  it('closes when the window is resized, so it is never left away from the Help item', async () => {
    renderApp('/', ready());
    await userEvent.click(helpButton());
    act(() => void window.dispatchEvent(new Event('resize')));
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('closes when the Help item is pressed again', async () => {
    renderApp('/', ready());
    await userEvent.click(helpButton());
    await userEvent.click(helpButton());
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('keeps the text typed in the search box when it opens and closes', async () => {
    renderApp('/', ready());
    const box = await screen.findByRole('searchbox', { name: 'Search text' });
    await userEvent.type(box, 'ACC-1');
    await userEvent.click(helpButton());
    await userEvent.click(helpButton());
    expect(box).toHaveProperty('value', 'ACC-1');
  });

  it('shows what its list holds: a sixth item gives six items', async () => {
    const sixth: HelpItem = { kind: 'link', id: 'extra', label: 'Take the tour', href: 'https://example.com/tour' };
    render(
      <ClientStateProvider state={createClientState()}>
        <KeyBindingsProvider registry={builtInKeyBindings()}>
          <HelpMenu items={[sixth, ...HELP_ITEMS]} />
        </KeyBindingsProvider>
      </ClientStateProvider>,
    );
    await userEvent.click(helpButton());
    expect(screen.getAllByRole('menuitem')).toHaveLength(6);
  });
});

describe('the Help menu by keyboard', () => {
  const opened = async (key: string) => {
    const view = renderApp('/', ready());
    helpButton().focus();
    await userEvent.keyboard(key);
    return view;
  };
  const focusedName = () => document.activeElement?.textContent;

  it.each(['{Enter}', ' '])('opens with %j on the Help item and puts the focus on the first item', async (key) => {
    await opened(key);
    expect(screen.getByRole('menu', { name: 'Help' })).toBeTruthy();
    expect(document.activeElement).toBe(screen.getAllByRole('menuitem')[0]);
  });

  it('does not open on an arrow while closed', async () => {
    renderApp('/', ready());
    helpButton().focus();
    await userEvent.keyboard('{ArrowDown}{ArrowUp}{Home}{End}');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('moves with the arrows, wrapping at the ends, and with Home and End', async () => {
    await opened('{Enter}');
    await userEvent.keyboard('{ArrowDown}');
    expect(focusedName()).toBe('Documentation↗');
    await userEvent.keyboard('{End}');
    expect(focusedName()).toBe('Report a problem↗');
    await userEvent.keyboard('{ArrowDown}');
    expect(focusedName()).toBe('Keyboard shortcuts⌘/');
    await userEvent.keyboard('{ArrowUp}');
    expect(focusedName()).toBe('Report a problem↗');
    await userEvent.keyboard('{Home}');
    expect(focusedName()).toBe('Keyboard shortcuts⌘/');
  });

  it('follows a link with Enter and closes', async () => {
    await opened('{Enter}');
    await userEvent.keyboard('{ArrowDown}');
    const link = screen.getByRole('menuitem', { name: /^Documentation/ });
    const clicked: string[] = [];
    link.addEventListener('click', (event) => {
      event.preventDefault();
      clicked.push(link.getAttribute('href') ?? '');
    });
    await userEvent.keyboard('{Enter}');
    expect(clicked).toEqual([HELP_LINKS.documentation]);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('closes on Esc and gives the focus back to the Help item', async () => {
    await opened('{Enter}');
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(helpButton());
  });

  it('does nothing on Esc while closed', async () => {
    renderApp('/', ready());
    helpButton().focus();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(helpButton());
  });

  it('closes on Tab and Shift+Tab and moves the focus on in the page order', async () => {
    await opened('{Enter}');
    await userEvent.tab();
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).not.toBe(helpButton());
    expect(document.activeElement).not.toBe(document.body);
    expect(helpButton().compareDocumentPosition(document.activeElement ?? document.body) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    helpButton().focus();
    await userEvent.keyboard('{Enter}');
    await userEvent.tab({ shift: true });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(helpButton().compareDocumentPosition(document.activeElement ?? document.body) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
  });

  it('leaves the focus where a press outside put it', async () => {
    await opened('{Enter}');
    const box = await screen.findByRole('searchbox', { name: 'Search text' });
    await userEvent.click(box);
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(box);
  });

  it('keeps the page keys from running while the focus is in the menu', async () => {
    const view = await opened('{Enter}');
    await userEvent.keyboard('{Control>}k{/Control}{Meta>}k{/Meta}');
    expect(view.router.state.location.pathname).toBe('/');
  });
});

describe('the shortcut sheet from the start page', () => {
  const sheet = () => screen.queryByRole('dialog', { name: 'Keyboard shortcuts' });

  it('opens from the menu item, closes the menu and puts the focus in the sheet; Esc gives the focus back to the Help item', async () => {
    renderApp('/', ready());
    await userEvent.click(helpButton());
    await userEvent.click(screen.getByRole('menuitem', { name: /^Keyboard shortcuts/ }));
    expect(screen.queryByRole('menu')).toBeNull();
    expect(sheet()?.contains(document.activeElement)).toBe(true);
    await userEvent.keyboard('{Escape}');
    expect(sheet()).toBeNull();
    expect(document.activeElement).toBe(helpButton());
  });

  it.each(['/', '/investigations', '/sources'])('opens and closes on the shortcut key on %s', async (path) => {
    renderApp(path, ready());
    await screen.findByRole('complementary');
    await userEvent.keyboard('{Meta>}/{/Meta}');
    expect(sheet()).toBeTruthy();
    await userEvent.keyboard('{Meta>}/{/Meta}');
    expect(sheet()).toBeNull();
  });

  it('closes with its close button', async () => {
    renderApp('/', ready());
    await userEvent.keyboard('{Meta>}/{/Meta}');
    await userEvent.click(within(sheet() ?? document.body).getByRole('button', { name: 'Close' }));
    expect(sheet()).toBeNull();
  });

  it('keeps Tab inside the sheet and leaves the page behind it inert', async () => {
    renderApp('/', ready());
    await userEvent.keyboard('{Meta>}/{/Meta}');
    const dialog = sheet();
    for (let step = 0; step < 3; step += 1) {
      await userEvent.tab();
      expect(dialog?.contains(document.activeElement)).toBe(true);
    }
    expect(document.querySelector('.page-shell')?.hasAttribute('inert')).toBe(true);
    await userEvent.keyboard('{Escape}');
    expect(document.querySelector('.page-shell')?.hasAttribute('inert')).toBe(false);
  });

  it('lists the keys registered for the page, each once: Search and Keyboard shortcuts, none for the canvas', async () => {
    renderApp('/', ready());
    await userEvent.keyboard('{Meta>}/{/Meta}');
    const rows = [...(sheet()?.querySelectorAll('.sheet-row .sheet-label') ?? [])].map((label) => label.textContent);
    expect(rows).toEqual(['Search', 'Keyboard shortcuts']);
  });

  it('leaves the key to the browser while a text field has the focus', async () => {
    renderApp('/', ready());
    await userEvent.click(await screen.findByRole('searchbox', { name: 'Search text' }));
    await userEvent.keyboard('{Meta>}/{/Meta}');
    expect(sheet()).toBeNull();
  });
});
