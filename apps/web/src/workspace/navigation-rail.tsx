import { Fragment } from 'react';
import { Link, useLocation } from 'react-router';
import { BrandMark } from '../shell/brand-mark.js';
import { NAVIGATION, type NavigationItem } from '../shell/navigation.js';
import { answeredData, useShellData } from '../shell/shell-data.js';
import { RailIdentity } from './rail-identity.js';
import { Slot, useOccupant, type SlotName } from './slots.js';

function isCurrent(item: NavigationItem, pathname: string): boolean {
  const own = item.end ? pathname === item.to : pathname === item.to || pathname.startsWith(`${item.to}/`);
  return own || (item.alsoCurrentOn ?? []).some((path) => pathname === path || pathname.startsWith(`${path}/`));
}

function RailSlot({ name }: { readonly name: SlotName }) {
  const Occupant = useOccupant(name);
  return Occupant === undefined ? null : (
    <li>
      <Occupant />
    </li>
  );
}

export function NavigationRail() {
  const { pathname } = useLocation();
  const edition = answeredData(useShellData().me)?.edition;
  return (
    <div className="rail">
      <nav aria-label="Workspace">
        <span className="rail-brand">
          <BrandMark />
        </span>
        <ul>
          {NAVIGATION.map((item, index) => (
            <Fragment key={item.to}>
              {index === 1 ? <RailSlot name="search" /> : null}
              <li>
                <Link to={item.to} aria-label={item.label} aria-current={isCurrent(item, pathname) ? 'location' : undefined}>
                  <span className={`icon ${item.icon}`} aria-hidden="true" />
                </Link>
              </li>
            </Fragment>
          ))}
        </ul>
      </nav>
      <div className={edition === 'enterprise' ? 'rail-bottom rail-bottom-enterprise' : 'rail-bottom'}>
        <Slot name="settings" />
        <RailIdentity />
      </div>
    </div>
  );
}
