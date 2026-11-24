import { NavLink, useMatch } from 'react-router';
import { HELP_ITEMS } from '../help/help-items.js';
import { HelpMenu } from '../help/help-menu.js';
import { BrandMark } from './brand-mark.js';
import { IdentityBlock } from './identity-block.js';
import { useClientStateWhenProvided } from '../state/context.js';
import { useStoreSelector, type ReadableStore } from '../state/store.js';
import { ASSISTANT_PATH, NAVIGATION } from './navigation.js';
import { SourceLine } from './source-line.js';

const NO_INVESTIGATION: ReadableStore<null> = { getState: () => null, subscribe: () => () => undefined };

/** Where the Assistant entry goes: the investigation held in this window, else the page that says to open one. */
function useAssistantTarget(): string {
  const state = useClientStateWhenProvided();
  const held = useStoreSelector<{ readonly id: string | null } | null, string | null>(state?.investigation ?? NO_INVESTIGATION, (investigation) => investigation?.id ?? null);
  return held === null ? ASSISTANT_PATH : `${ASSISTANT_PATH}/${encodeURIComponent(held)}`;
}

export function Sidebar() {
  const assistantTarget = useAssistantTarget();
  const onStartPage = useMatch({ path: '/', end: true }) !== null;
  return (
    <aside className="sidebar">
      <div className="sidebar-top">
        <p className="brand">
          <BrandMark />
          Neburyx
        </p>
        <nav aria-label="Main">
          <ul>
            {NAVIGATION.map((item) => (
              <li key={item.to}>
                <NavLink to={item.to === ASSISTANT_PATH ? assistantTarget : item.to} end={item.end}>
                  <span className={`icon ${item.icon}`} aria-hidden="true" />
                  {item.label}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
      </div>
      <div className="sidebar-bottom">
        {onStartPage ? <HelpMenu items={HELP_ITEMS} /> : null}
        <SourceLine />
        <IdentityBlock />
      </div>
    </aside>
  );
}
