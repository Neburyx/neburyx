import type { CurrentSource } from './current-source.js';
import { answeredData, useShellData } from './shell-data.js';
import { useCurrentSource } from './use-current-source.js';

function sourceName(current: CurrentSource): string | undefined {
  return current.kind === 'bound' || current.kind === 'only' ? `${current.source.alias} · read-only` : undefined;
}

export function PageHeading({ title, description }: { readonly title: string; readonly description: string }) {
  const identity = answeredData(useShellData().me);
  const { current, showsSyntheticBadge: synthetic } = useCurrentSource();
  const name = current === undefined ? undefined : sourceName(current);
  return (
    <header className="page-heading">
      <div className="page-title">
        <h1>{title}</h1>
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
