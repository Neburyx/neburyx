import { useEffect, useRef } from 'react';
import type { CurrentSource } from './current-source.js';
import { answeredData, useShellData } from './shell-data.js';
import { useCurrentSource } from './use-current-source.js';

function sourceName(current: CurrentSource): string | undefined {
  return current.kind === 'bound' || current.kind === 'only' ? `${current.source.alias} · read-only` : undefined;
}

/** `source` replaces the line about the source in view: a name to show in its place, or `null` for a page that is about no source the shell knows, so it shows none and no Synthetic data badge. */
export function PageHeading({ title, description, source, focused = false }: { readonly title: string; readonly description: string; readonly source?: string | null; readonly focused?: boolean }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (focused) heading.current?.focus();
  }, [focused, title]);
  const identity = answeredData(useShellData().me);
  const { current, showsSyntheticBadge } = useCurrentSource();
  const synthetic = source === undefined && showsSyntheticBadge;
  const name = source !== undefined ? (source ?? undefined) : current === undefined ? undefined : sourceName(current);
  return (
    <header className="page-heading">
      <div className="page-title">
        <h1 ref={heading} tabIndex={focused ? -1 : undefined}>
          {title}
        </h1>
        {identity?.edition === 'enterprise' ? <span className="badge">Enterprise</span> : null}
      </div>
      {name === undefined && !synthetic ? null : (
        <div className="source-note">
          {name === undefined ? null : <span>{name}</span>}
          {synthetic ? <span className="badge">Synthetic data</span> : null}
        </div>
      )}
      <p>{description}</p>
    </header>
  );
}
