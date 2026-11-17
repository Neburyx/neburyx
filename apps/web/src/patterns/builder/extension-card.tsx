import type { SourceProfile } from '@neburyx/contracts';
import { extensionTags, withinTag } from '../copy.js';
import type { Draft } from './model.js';
import { timePropertiesOf } from './model.js';

interface Props {
  readonly profile: SourceProfile;
  readonly draft: Draft;
  readonly index: number;
  readonly nameOf: (type: string | undefined) => string;
  /** The step is marked: the mapping does not follow it, or the source refused it. */
  readonly wrong: boolean;
}

const DIRECTION_WORD = { out: 'outgoing', in: 'incoming', both: 'either way' } as const;

export function ExtensionCard({ profile, draft, index, nameOf, wrong }: Props) {
  const step = draft.steps[index];
  if (step === undefined || extensionTags(step).length === 0) return null;
  const properties = timePropertiesOf(profile, draft, index);
  const rows: [string, string][] = [];
  const kinds = [...(step.fan === undefined ? [] : [`at least N neighbours`]), ...(step.closesAtAnchor === undefined ? [] : ['closes back at the anchor']), ...(step.after === undefined ? [] : ['after the previous step'])];
  rows.push(['Kind', kinds.join(', ')]);
  if (step.fan !== undefined) rows.push(['N', String(step.fan.atLeast)]);
  if (step.closesAtAnchor !== undefined) rows.push(['Closes back at', `the start ${nameOf(draft.anchorType)}`]);
  if (step.after !== undefined) rows.push(['Ordered by', properties.length === 0 ? 'no time in the mapping' : `${properties.join(', ')} (date)`]);
  if (step.within !== undefined) rows.push(['No later than', withinTag(step.within).replace(/^within /, '') + ' after the previous step']);
  rows.push(['Relationship', `${step.relationshipTypes.join(', ')}, ${DIRECTION_WORD[step.direction ?? 'out']}`]);
  if (step.arrivesAt !== undefined) rows.push(['Arrives at', nameOf(step.arrivesAt)]);
  return (
    <section className="pattern-ext-card" data-broken={wrong ? 'true' : undefined} aria-label={`Step ${index + 1} extended`}>
      <p className="pattern-step-title">
        {`Step ${index + 1} · ${kinds.join(', ').replace('at least N neighbours', 'at least N neighbours')}`}
        {wrong ? <span className="pattern-ext-pill">Not valid</span> : null}
      </p>
      <dl className="pattern-ext-table">
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      <p className="pattern-help">{wrong ? 'Kept and marked. Not editable yet.' : 'Shown here, not editable yet. It can be run and kept as it is.'}</p>
    </section>
  );
}
