import { HeaderSource } from './header-source.js';
import { InvestigationIdentity } from './investigation-identity.js';
import { Slot } from './slots.js';

export function HeaderBar() {
  return (
    <header className="header-bar" aria-label="Investigation">
      <InvestigationIdentity />
      <div className="header-actions">
        <HeaderSource />
        <Slot name="ask" />
        <Slot name="summarize" />
        <Slot name="views" />
        <Slot name="export" />
        <Slot name="save" />
      </div>
    </header>
  );
}
