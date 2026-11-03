import type { CurrentSource } from './current-source.js';

export function SourceStatusText({ current }: { readonly current: CurrentSource }) {
  switch (current.kind) {
    case 'none':
      return <p>No source connected</p>;
    case 'only':
    case 'bound':
      return (
        <p>
          <span aria-hidden="true">● </span>
          {current.source.alias} · read-only · {current.source.state}
          {current.source.stateReason === null ? '' : ` · ${current.source.stateReason}`}
        </p>
      );
    case 'bound-unknown':
      return (
        <p>
          <span aria-hidden="true">● </span>
          {current.sourceId} · read-only · unknown
        </p>
      );
    case 'summary':
      return (
        <p>
          {current.total} sources · {current.connected} connected
        </p>
      );
    default: {
      const unreachable: never = current;
      return unreachable;
    }
  }
}
