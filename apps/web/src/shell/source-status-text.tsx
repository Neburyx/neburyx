import type { CurrentSource } from './current-source.js';

/** The status of the source: its alias, read-only and its state, and with `reason` (the default) the reason of the state too; the sidebar leaves it out, the Sources page and the workspace header hold it. */
export function SourceStatusText({ current, reason = true }: { readonly current: CurrentSource; readonly reason?: boolean }) {
  switch (current.kind) {
    case 'none':
      return <p>No source connected</p>;
    case 'only':
    case 'bound':
      return (
        <p>
          <span aria-hidden="true">● </span>
          {current.source.alias} · read-only · {current.source.state}
          {!reason || current.source.stateReason === null ? '' : ` · ${current.source.stateReason}`}
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
