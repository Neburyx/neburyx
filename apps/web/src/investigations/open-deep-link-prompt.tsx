import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { MAX_CASE_REF_LENGTH, MAX_REFERENCE_VALUE_CHARACTERS, MAX_STABLE_ID_LENGTH } from '@neburyx/contracts';
import { useApiClient } from '../api/client-context.js';
import { answeredData, useShellData } from '../shell/shell-data.js';
import { EXPLORE_PATH } from '../shell/navigation.js';
import { useClientState, useSessionMask } from '../state/context.js';
import { characters, deepLinkPath, readDeepLink, SOURCE_ID } from './deep-link.js';
import { openEntity } from './open-flow.js';
import { PROMPT_GIVE_ENTITY_TYPE, PROMPT_GIVE_SOURCE, PROMPT_GIVE_STABLE_ID, PROMPT_LABELS, PROMPT_MASKED_VALUE, PROMPT_NOT_A_LINK, PROMPT_NOT_FOUND, PROMPT_NOT_OF_THIS_APP, PROMPT_SOURCE_UNAVAILABLE, PROMPT_OPEN, PROMPT_SOURCE_SHAPE, promptTooLong } from './messages.js';

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
  // a value is counted in UTF-16 code units, as the contract counts it
  if (parts.stableId.length > MAX_REFERENCE_VALUE_CHARACTERS) return promptTooLong('stable ID', MAX_REFERENCE_VALUE_CHARACTERS);
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
  const client = useApiClient();
  const state = useClientState();
  const mask = useSessionMask();
  const principalId = answeredData(useShellData().me)?.principal.id;
  const [text, setText] = useState('');
  const [linkProblem, setLinkProblem] = useState<string | undefined>(undefined);
  const [parts, setParts] = useState<Parts>({ sourceId: '', entityType: '', stableId: '', caseRef: '' });
  const [partsProblem, setPartsProblem] = useState<string | undefined>(undefined);
  const attempt = useRef<AbortController | undefined>(undefined);
  // an answer that comes after the page was left, another value was sent, or masking changed is not applied
  useEffect(() => () => attempt.current?.abort(), []);
  useEffect(() => attempt.current?.abort(), [mask]);

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
    if (problem !== undefined) return setPartsProblem(problem);
    if (principalId === undefined) return setPartsProblem(PROMPT_NOT_A_LINK);
    setPartsProblem(undefined);
    // the typed value goes in the body of the open request and never into an address: the investigation's own address follows
    const request = { sourceId: parts.sourceId, entity: { sourceId: parts.sourceId, entityType: parts.entityType, value: parts.stableId }, ...(parts.caseRef === '' ? {} : { caseRef: parts.caseRef }) };
    attempt.current?.abort();
    const controller = new AbortController();
    attempt.current = controller;
    void openEntity(client, state, request, { principalId, mask }, controller.signal).then((answer) => {
      if (controller.signal.aborted) return;
      if (answer.kind === 'shown') navigate(`${EXPLORE_PATH}/${answer.id}`, { state: { resumed: answer.created === false } });
      else if (answer.kind === 'source-unavailable') setPartsProblem(PROMPT_SOURCE_UNAVAILABLE);
      else if (answer.failure.code === 'INVALID_REQUEST' && mask) setPartsProblem(PROMPT_MASKED_VALUE);
      else if (answer.failure.code === 'NOT_FOUND') setPartsProblem(PROMPT_NOT_FOUND);
      else setPartsProblem(`The entity could not be opened (${answer.failure.code}).`);
    });
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
