import { useShellData, answeredData } from '../shell/shell-data.js';
import { READ_ONLY, SERVER_LABEL, SOURCE_LABEL } from './copy.js';

/** Where the evidence came from: the source's name and, when a test of it answered, the server product and version, and that the source is read-only. Nothing else. */
export function SourceTab({ sourceId }: { readonly sourceId: string }) {
  const sources = answeredData(useShellData().sources)?.items ?? [];
  const source = sources.find((item) => item.id === sourceId);
  const server = source?.lastTest?.server ?? undefined;
  return (
    <div className="evidence-source">
      <dl className="inspector-rows">
        <div className="inspector-row">
          <dt>{SOURCE_LABEL}</dt>
          <dd>{source?.alias ?? sourceId}</dd>
        </div>
        {server === undefined ? null : (
          <div className="inspector-row">
            <dt>{SERVER_LABEL}</dt>
            <dd>{`${server.product} ${server.version}`}</dd>
          </div>
        )}
      </dl>
      <p>{READ_ONLY}</p>
    </div>
  );
}
