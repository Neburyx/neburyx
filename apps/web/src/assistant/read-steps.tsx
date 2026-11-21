import type { AssistantRead } from '@neburyx/contracts';
import { humanize } from '../ask/text.js';
import { ASSISTANT_COPY } from './copy.js';

const figure = (value: number): string => value.toLocaleString('en-US');
const rowsOf = (value: number): string => `${figure(value)} ${value === 1 ? 'row' : 'rows'}`;

/** The tag of a kind, as the registry names it: a folder intent, a catalog template, a pattern of the person, the view, or one of the application's own reads. */
export const READ_KIND_TAGS: Readonly<Record<AssistantRead['kind'], string>> = { intent: 'Folder intent', template: 'Template', pattern: 'Your pattern', view: 'View', typology: 'Typology', 'ai-notes': 'Your AI notes', 'ai-summary': 'AI case summary' };

const linesOf = (value: number): string => `${figure(value)} ${value === 1 ? 'line' : 'lines'}`;

const QUALITY_CHIPS = { exact: 'Exact', estimated: 'Estimated', lowerBound: 'Lower bound', unknown: 'Unknown' } as const;

/** The line under a read's title: its subject (after "from" for a pattern), the rows as the quality of the count allows, and whether it is complete or partial; a count that is not known has no number. */
export function readLine(entry: AssistantRead): string {
  if (!entry.read) return ASSISTANT_COPY.notRead;
  const subject = entry.subject === undefined ? undefined : `${entry.kind === 'pattern' ? 'from ' : ''}${entry.subject}`;
  const state = entry.partial ? 'partial' : 'complete';
  const count = entry.rows === undefined ? undefined : entry.quality === 'estimated' ? `~ ${rowsOf(entry.rows)} (estimated)` : entry.quality === 'lowerBound' ? `≥ ${rowsOf(entry.rows)}` : rowsOf(entry.rows);
  const parts = entry.lines !== undefined ? [subject, linesOf(entry.lines), state] : entry.rows === undefined ? [subject, state, 'no row count'] : [subject, count, state];
  return parts.filter((part): part is string => part !== undefined).join(' · ');
}

/** One read as the frame draws it: Ran or Did not run, the tag of its kind, and the line of its subject, rows, state and the quality chip. */
export function ReadBox({ entry }: { readonly entry: AssistantRead }) {
  return (
    <li className="assistant-read">
      <p className="assistant-read-title">
        <span>{entry.read ? `Ran ${entry.label ?? humanize(entry.tool)}` : `Did not run ${entry.label ?? humanize(entry.tool)}`}</span>
        <span className="ask-tag">{READ_KIND_TAGS[entry.kind]}</span>
      </p>
      <p className="assistant-read-line">
        <span>{readLine(entry)}</span>
        {entry.read ? <span className={`ask-tag ${entry.quality === 'exact' ? 'ask-tag-exact' : 'ask-tag-caution'}`}>{QUALITY_CHIPS[entry.quality]}</span> : null}
      </p>
    </li>
  );
}

/**
 * The reads of a turn, one box each. Closed behind "Steps · N" by default; shown open, with no disclosure, in a stop or a confirmation, where the frame draws them above the card.
 */
export function ReadSteps({ reads, open = false }: { readonly reads: readonly AssistantRead[]; readonly open?: boolean }) {
  if (reads.length === 0) return null;
  const list = (
    <>
      <ul className="assistant-reads">
        {reads.map((entry, index) => (
          <ReadBox key={`${index}-${entry.tool}`} entry={entry} />
        ))}
      </ul>
      {open ? null : <p className="assistant-reads-note">{ASSISTANT_COPY.readsNote}</p>}
    </>
  );
  if (open) return <div className="assistant-steps assistant-steps-open">{list}</div>;
  return (
    <details className="assistant-steps">
      <summary>{`${ASSISTANT_COPY.steps} · ${reads.length}`}</summary>
      {list}
    </details>
  );
}
