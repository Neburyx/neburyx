import type { PatternProblem } from '@neburyx/contracts';
import { problemText } from '../copy.js';
import { CHECK_COPY, PART_NAME, placeOf, type ProblemPlace } from './copy.js';

interface Props {
  readonly problems: readonly PatternProblem[];
  /** Opens the tab and part the problem is in and puts the focus on its control. */
  readonly onShow: (place: ProblemPlace) => void;
}

/** The place of a problem in words: the step and the part of it, or the start. */
const whereText = (place: ProblemPlace): string | undefined => {
  switch (place.kind) {
    case 'start':
      return 'Start';
    case 'step':
      return `Step ${place.index + 1} · ${PART_NAME.link}`;
    case 'condition':
      return `Step ${place.index + 1} · ${PART_NAME.conditions}`;
    case 'window':
      return `Step ${place.index + 1} · ${PART_NAME.window}`;
    default:
      return undefined;
  }
};

/** What the source found wrong, one line each with its step and part and Show, which opens that part and focuses the row; a problem with no place of its own has no Show. */
export function ProblemsPanel({ problems, onShow }: Props) {
  if (problems.length === 0) return null;
  return (
    <div className="patterns-state pattern-problems" data-tone="bad" role="group" aria-label={CHECK_COPY.problemsTitle}>
      <p className="pattern-breaks-title">{CHECK_COPY.problemsTitle}</p>
      <ol className="pattern-problems-list">
        {problems.map((problem, index) => {
          const place = placeOf(problem);
          const where = whereText(place);
          return (
            <li key={`${problem.code}-${index}`}>
              <span>{where === undefined ? problemText(problem) : `${where}: ${problemText(problem)}`}</span>
              {where === undefined ? null : (
                <button type="button" className="secondary" aria-label={`${CHECK_COPY.show} problem ${index + 1}`} onClick={() => onShow(place)}>
                  {CHECK_COPY.show}
                </button>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
