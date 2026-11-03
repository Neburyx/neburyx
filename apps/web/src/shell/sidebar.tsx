import { NavLink } from 'react-router';
import { BrandMark } from './brand-mark.js';
import { IdentityBlock } from './identity-block.js';
import { SourceLine } from './source-line.js';

const NAVIGATION = [
  { to: '/', label: 'Home', icon: 'icon-home', end: true },
  { to: '/investigations', label: 'Investigations', icon: 'icon-investigations', end: false },
  { to: '/sources', label: 'Sources', icon: 'icon-sources', end: false },
] as const;

export function Sidebar() {
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
        <SourceLine />
        <IdentityBlock />
      </div>
    </aside>
  );
}
