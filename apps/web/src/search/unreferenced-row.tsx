import type { UnreferencedHit } from '@neburyx/contracts';
import { UNREFERENCED_TEXT, unreferencedLabel } from './copy.js';
import { useFocusOnMount } from './show-more.js';

/**
 * A hit with no usable stable ID, under its group: its title, its type and why nothing can be done with it. It is not a button and has no action, because it has no reference to open, add or
 * expand by. `focus` asks for the row to take the focus when it is first drawn: the first hit of a page Show more added.
 */
export function UnreferencedRow({ hit, typeName, className, focus = false }: { readonly hit: UnreferencedHit; readonly typeName: string; readonly className: string; readonly focus?: boolean }) {
  const row = useFocusOnMount<HTMLLIElement>(focus);
  return (
    <li className={`${className} search-hit-unreferenced`} aria-label={unreferencedLabel(hit.title, typeName)} ref={row} {...(focus ? { tabIndex: -1 } : {})}>
      <div className="search-hit-text">
        <span className="search-hit-type">{typeName}</span>
        <strong>{hit.title}</strong>
        <span className="search-hit-context">{UNREFERENCED_TEXT}</span>
      </div>
    </li>
  );
}
