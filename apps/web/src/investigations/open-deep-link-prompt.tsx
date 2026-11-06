import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { MAX_CASE_REF_LENGTH, MAX_STABLE_ID_LENGTH } from '@neburyx/contracts';
import { characters, deepLinkPath, readDeepLink, SOURCE_ID, type DeepLink } from './deep-link.js';
import { PROMPT_GIVE_ENTITY_TYPE, PROMPT_GIVE_SOURCE, PROMPT_GIVE_STABLE_ID, PROMPT_LABELS, PROMPT_NOT_A_LINK, PROMPT_NOT_OF_THIS_APP, PROMPT_OPEN, PROMPT_SOURCE_SHAPE, promptTooLong } from './messages.js';

interface Parts {
  readonly sourceId: string;
  readonly entityType: string;
  readonly stableId: string;
  readonly caseRef: string;
}

/** What is wrong with the parts, in the order of the fields, or undefined when they make a link. */
function problemWith(parts: Parts): string | undefined {
  if (parts.sourceId === '') return PROMPT_GIVE_SOURCE;
  if (parts.entityType === '') return PROMPT_GIVE_ENTITY_TYPE;
  if (parts.stableId === '') return PROMPT_GIVE_STABLE_ID;
  if (!SOURCE_ID.test(parts.sourceId)) return PROMPT_SOURCE_SHAPE;
  if (characters(parts.entityType) > MAX_STABLE_ID_LENGTH) return promptTooLong('entity type', MAX_STABLE_ID_LENGTH);
  if (characters(parts.stableId) > MAX_STABLE_ID_LENGTH) return promptTooLong('stable ID', MAX_STABLE_ID_LENGTH);
  if (characters(parts.caseRef) > MAX_CASE_REF_LENGTH) return promptTooLong('case reference', MAX_CASE_REF_LENGTH);
  return undefined;
}

function Message({ id, text }: { readonly id: string; readonly text: string | undefined }) {
  const element = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (text !== undefined) element.current?.focus();
  }, [text]);
  return text === undefined ? null : (
    <p id={id} role="alert" tabIndex={-1} ref={element}>
      {text}
    </p>
  );
}

/** The two ways to name a link: paste it, or type its parts. Each form uses only its own fields and goes to the route of the link it makes. */
export function OpenDeepLinkPrompt() {
  const navigate = useNavigate();
  const [text, setText] = useState('');
  const [linkProblem, setLinkProblem] = useState<string | undefined>(undefined);
  const [parts, setParts] = useState<Parts>({ sourceId: '', entityType: '', stableId: '', caseRef: '' });
  const [partsProblem, setPartsProblem] = useState<string | undefined>(undefined);

  const openText = (event: FormEvent): void => {
    event.preventDefault();
    const read = readDeepLink(text, window.location.origin);
    if (!read.ok) return setLinkProblem(read.reason === 'foreign' ? PROMPT_NOT_OF_THIS_APP : PROMPT_NOT_A_LINK);
    setLinkProblem(undefined);
    navigate(deepLinkPath(read.link));
  };

  const openParts = (event: FormEvent): void => {
    event.preventDefault();
    const problem = problemWith(parts);
    const link: DeepLink = { sourceId: parts.sourceId, entityType: parts.entityType, stableId: parts.stableId, ...(parts.caseRef === '' ? {} : { caseRef: parts.caseRef }) };
    const read = problem === undefined ? readDeepLink(deepLinkPath(link), window.location.origin) : undefined;
    if (problem !== undefined || read === undefined || !read.ok) return setPartsProblem(problem ?? PROMPT_NOT_A_LINK);
    setPartsProblem(undefined);
    navigate(deepLinkPath(read.link));
  };

  const setPart = (name: keyof Parts, value: string): void => setParts((held) => ({ ...held, [name]: value }));

  return (
    <div>
      <form aria-label={PROMPT_LABELS.form} onSubmit={openText}>
        <label>
          {PROMPT_LABELS.link}
          <input value={text} onChange={(event) => setText(event.target.value)} aria-describedby={linkProblem === undefined ? undefined : 'deep-link-text-problem'} aria-invalid={linkProblem !== undefined} />
        </label>
        <button type="submit" className="primary">
          {PROMPT_OPEN}
        </button>
        <Message id="deep-link-text-problem" text={linkProblem} />
      </form>
      <form aria-label={PROMPT_LABELS.partsForm} onSubmit={openParts}>
        <label>
          {PROMPT_LABELS.source}
          <input value={parts.sourceId} onChange={(event) => setPart('sourceId', event.target.value)} />
        </label>
        <label>
          {PROMPT_LABELS.entityType}
          <input value={parts.entityType} onChange={(event) => setPart('entityType', event.target.value)} />
        </label>
        <label>
          {PROMPT_LABELS.stableId}
          <input value={parts.stableId} onChange={(event) => setPart('stableId', event.target.value)} />
        </label>
        <label>
          {PROMPT_LABELS.caseRef}
          <input value={parts.caseRef} onChange={(event) => setPart('caseRef', event.target.value)} />
        </label>
        <button type="submit" className="primary">
          {PROMPT_OPEN}
        </button>
        <Message id="deep-link-parts-problem" text={partsProblem} />
      </form>
    </div>
  );
}
