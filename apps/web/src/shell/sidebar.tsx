import { NavLink, useMatch } from 'react-router';
import { HELP_ITEMS } from '../help/help-items.js';
import { HelpMenu } from '../help/help-menu.js';
import { BrandMark } from './brand-mark.js';
import { IdentityBlock } from './identity-block.js';
import { NAVIGATION } from './navigation.js';
import { SourceLine } from './source-line.js';

export function Sidebar() {
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
                <NavLink to={item.to} end={item.end}>
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
