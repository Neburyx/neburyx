import { useClientState } from '../state/context.js';
import { useStoreSelector } from '../state/store.js';
import { currentSource, showsSyntheticBadge } from './current-source.js';
import { answeredData, useShellData } from './shell-data.js';

function sourceName(current: ReturnType<typeof currentSource>): string | undefined {
  return current.kind === 'bound' || current.kind === 'only' ? `${current.source.alias} · read-only` : undefined;
}

export function PageHeading({ title, description }: { readonly title: string; readonly description: string }) {
  const { me, sources } = useShellData();
  const state = useClientState();
  const boundId = useStoreSelector(state.investigation, (current) => current.sourceId);
  const identity = answeredData(me);
  const list = answeredData(sources);
  const current = list === undefined ? undefined : currentSource(list.items, boundId);
  const name = current === undefined ? undefined : sourceName(current);
  const synthetic = list !== undefined && current !== undefined && showsSyntheticBadge(current, list.items);
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
