import { COPY } from './copy.js';
import { degreeNotice, type LastTestView } from './health-facts.js';

export function DegreeNotice({ view }: { readonly view: LastTestView }) {
  const notice = degreeNotice(view);
  if (notice === undefined) return null;
  if (notice.kind === 'not-run') return <p className="facts-note">{COPY.degreeNotRun}</p>;
  return (
    <div className="degree-warning">
      <span className="icon icon-warning" aria-hidden="true" />
      <ul>
        {notice.warnings.map((warning) => (
          <li key={warning}>{warning}</li>
        ))}
      </ul>
    </div>
  );
}
