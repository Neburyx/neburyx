import { useEffect, useMemo, useRef, useState } from 'react';
import type { GraphNode, PathsOk } from '@neburyx/contracts';
import { useEntitySearch } from '../patterns/start-entity.js';
import type { ApiClient } from '../api/client.js';
import { withoutReadsWhileSourceChanged } from '../api/changed-source-guard.js';
import { useApiClient } from '../api/client-context.js';
import { useProfile } from '../canvas/profile-context.js';
import { answeredData, useShellData } from '../shell/shell-data.js';
import { useClientState, useLoadedGraph, useSessionMask, useVisibleGraph } from '../state/context.js';
import { partitionEdges } from '../state/loaded-graph.js';
import { edgeKey, elementKey } from '../state/keys.js';
import { useStoreSelector } from '../state/store.js';
import { DIRECTION_LABELS, EVIDENCE_NONE, failureText, evidenceLabel, FAILED_TEXT, hiddenByFiltersText, SELECTED_LABEL, NO_SOURCE_TEXT, noPathText, PATHS_COPY, pathTitle, PROBLEM_TEXT, RETRY_LABEL, summaryText, timeoutLabel } from './copy.js';
import { useEvidenceHandle } from '../patterns/evidence-handle.js';
import { choosePath, type ChosenOutcome } from './choose-path.js';
import { edgeOfStep, elementsOf } from './path-elements.js';
import { useBanner } from '../banner/banner-context.js';
import { usePathsEnvironment } from './paths-context.js';
import { choiceOf, DEFAULT_LIMIT, initialForm, problemOf, relationshipTypesOf, requestOf, type EndChoice, type PathsForm } from './paths-form.js';
import { focusPathsTool } from './paths-tool.js';
import { usePathsRun } from './use-paths-run.js';

const DIRECTIONS = ['both', 'out', 'in'] as const;

interface EndFieldProps {
  readonly client: ApiClient;
  readonly sourceId: string;
  readonly mask: boolean;
  readonly id: string;
  readonly label: string;
  readonly candidates: readonly GraphNode[];
  readonly chosen: EndChoice | undefined;
  readonly onChoose: (choice: EndChoice | undefined) => void;
  readonly selectRef?: React.Ref<HTMLSelectElement>;
}

/** An end is chosen from the entities of the loaded graph, the selected ones first. */
function EndField({ client, sourceId, mask, id, label, candidates, chosen, onChoose, selectRef }: EndFieldProps) {
  const [text, setText] = useState('');
  const { found, asked } = useEntitySearch(client, sourceId, mask, undefined, text);
  const loadedKeys = new Set(candidates.map((node) => elementKey(node.ref)));
  const hits = found.kind === 'found' ? found.nodes.filter((node) => !loadedKeys.has(elementKey(node.ref))) : [];
  const options = [...candidates, ...hits];
  const chosenOutside = chosen !== undefined && !options.some((node) => elementKey(node.ref) === elementKey(chosen.ref));
  return (
    <div className="patterns-field">
      <label htmlFor={id}>{label}</label>
      <select id={id} className="patterns-input" ref={selectRef} value={chosen === undefined ? '' : elementKey(chosen.ref)} onChange={(event) => {
          const node = options.find((candidate) => elementKey(candidate.ref) === event.target.value);
          onChoose(node === undefined ? undefined : choiceOf(node));
        }}>
        <option value="">{PATHS_COPY.choose}</option>
        {chosenOutside ? <option value={elementKey(chosen.ref)}>{chosen.title}</option> : null}
        {candidates.map((node) => (
          <option key={elementKey(node.ref)} value={elementKey(node.ref)}>
            {node.display.title}
          </option>
        ))}
        {hits.map((node) => (
          <option key={elementKey(node.ref)} value={elementKey(node.ref)}>
            {node.display.title} ({node.display.type})
          </option>
        ))}
      </select>
      <input type="search" className="patterns-input" aria-label={`${PATHS_COPY.searchLabel}: ${label}`} placeholder={PATHS_COPY.searchLabel} autoComplete="off" value={text} onChange={(event) => setText(event.target.value)} />
      {found.kind === 'failed' ? (
        <p className="patterns-error" role="alert">
          {PATHS_COPY.searchFailed}
        </p>
      ) : asked && found.kind === 'found' && found.nodes.length === 0 ? (
        <p className="search-panel-note">{PATHS_COPY.searchNone}</p>
      ) : null}
    </div>
  );
}

function titlesOf(result: PathsOk): ReadonlyMap<string, string> {
  return new Map(result.nodes.map((node) => [elementKey(node.ref), node.display.title]));
}

interface PathListProps {
  readonly result: PathsOk;
  readonly chosen: number | undefined;
  readonly onChoose: (position: number) => void;
  /** The opener of the evidence of a step's relationship, when it is on the canvas and a kind of evidence offers it. */
  readonly evidenceOf: (step: PathsOk['paths'][number]['steps'][number], reference: string) => (() => void) | undefined;
}

function PathList({ result, chosen, onChoose, evidenceOf }: PathListProps) {
  const titles = titlesOf(result);
  const titleOf = (ref: PathsOk['paths'][number]['steps'][number]['from']): string => titles.get(elementKey(ref)) ?? ref.stableId;
  return (
    <ol className="paths-list" aria-label={PATHS_COPY.results}>
      {result.paths.map((path, position) => (
        <li key={position} className="paths-item">
          <h3 className="paths-item-title">
            <button type="button" className="paths-choose" aria-pressed={chosen === position} onClick={() => onChoose(position)}>
              {pathTitle(position + 1, path.hops)}
            </button>
            {chosen === position ? <span className="paths-selected"> · {SELECTED_LABEL}</span> : null}
          </h3>
          <ol className="paths-steps" aria-label={PATHS_COPY.steps}>
            {path.steps.map((step, index) => (
              <li key={index}>
                <span>
                  {titleOf(step.from)} → {titleOf(step.to)}
                </span>
                {step.evidenceRefs.length === 0 ? (
                  <span className="paths-evidence"> {EVIDENCE_NONE}</span>
                ) : (
                  step.evidenceRefs.map((reference) => {
                    const open = chosen === position ? evidenceOf(step, reference) : undefined;
                    return open === undefined ? (
                      <span key={reference} className="paths-evidence">
                        {' '}
                        {evidenceLabel(reference)}
                      </span>
                    ) : (
                      <button key={reference} type="button" className="paths-evidence-open" onClick={open}>
                        {evidenceLabel(reference)}
                      </button>
                    );
                  })
                )}
              </li>
            ))}
          </ol>
        </li>
      ))}
    </ol>
  );
}

export function PathsPanel() {
  const state = useClientState();
  const open = useApiClient();
  const client = useMemo(() => withoutReadsWhileSourceChanged(open, state), [open, state]);
  const mask = useSessionMask();
  const sourceId = useStoreSelector(state.investigation, (investigation) => investigation.sourceId);
  const shell = useShellData();
  const profile = useProfile();
  const { report, tracker } = usePathsEnvironment();
  const source = sourceId === null ? undefined : answeredData(shell.sources)?.items.find((item) => item.id === sourceId);
  const types = useMemo(() => relationshipTypesOf(profile), [profile]);
  const loaded = useLoadedGraph();
  const selection = useStoreSelector(state.presentation.view, (view) => view.selection);
  const banner = useBanner();
  const investigationId = useStoreSelector(state.investigation, (investigation) => investigation.id);
  const timeoutOfSource = source?.timeoutMs;
  const options = useMemo(() => ({ ...(report === undefined ? {} : { report }), ...(tracker === undefined ? {} : { tracker }), banner, timeoutMs: () => timeoutOfSource, focus: (target: 'from' | 'list') => state.presentation.requestPathsFocus(target) }), [report, tracker, banner, timeoutOfSource, state]);
  const run = usePathsRun(open, `${sourceId ?? ''}\u0000${investigationId ?? ''}\u0000${mask}`, client, sourceId ?? '', options);
  const [from, setFrom] = useState<EndChoice | undefined>(undefined);
  const [to, setTo] = useState<EndChoice | undefined>(undefined);
  const [maxHops, setMaxHops] = useState<number>(() => initialForm(source?.maxHops, types).maxHops);
  const [direction, setDirection] = useState<PathsForm['direction']>('both');
  const [limit, setLimit] = useState<number>(DEFAULT_LIMIT);
  const [off, setOff] = useState<ReadonlySet<string>>(new Set());
  const [chosen, setChosen] = useState<{ readonly result: PathsOk; readonly position: number; readonly outcome: ChosenOutcome } | undefined>(undefined);
  const evidence = useEvidenceHandle();
  const visible = useVisibleGraph();
  const principalId = answeredData(shell.me)?.principal.id;
  const listRef = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const fromField = useRef<HTMLSelectElement>(null);
  const escape = useRef<() => void>(() => undefined);

  const form: PathsForm = { from, to, maxHops, direction, limit, relTypes: new Set(types.filter((type) => !off.has(type))) };
  const problem = problemOf(form);
  const candidates = useMemo(() => [...loaded.nodes].sort((left, right) => Number(selection.has(elementKey(right.ref))) - Number(selection.has(elementKey(left.ref)))), [loaded, selection]);
  const close = (): void => {
    state.presentation.setPathsOpen(false);
    focusPathsTool();
  };
  escape.current = run.running ? run.cancel : close;
  const sourceMaxHops = source?.maxHops;
  useEffect(() => {
    if (sourceMaxHops !== undefined) setMaxHops((current) => Math.min(current, sourceMaxHops));
  }, [sourceMaxHops]);

  useEffect(() => {
    const frame = root.current?.closest('.panel-frame');
    if (frame === null || frame === undefined) return undefined;
    const onKey = (event: Event): void => {
      if (!(event instanceof KeyboardEvent) || event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      escape.current();
    };
    frame.addEventListener('keydown', onKey);
    return () => frame.removeEventListener('keydown', onKey);
  }, []);

  const find = (): void => {
    if (sourceId === null) return;
    const ask = requestOf(form, sourceId, mask, types);
    if (ask !== undefined) run.run(ask);
  };
  const changed = (): void => run.clear();
  const focusRequest = useStoreSelector(state.presentation.view, (view) => view.pathsFocus);
  useEffect(() => {
    if (focusRequest === undefined) return;
    if (focusRequest.target === 'from') fromField.current?.focus();
    else {
      listRef.current?.scrollIntoView?.();
      listRef.current?.querySelector<HTMLElement>('.paths-choose')?.focus();
    }
    state.presentation.clearPathsFocus();
  }, [focusRequest, state]);
  const handover = useStoreSelector(state.presentation.view, (view) => view.pathsHandover);
  useEffect(() => {
    if (handover === undefined) return;
    const loadedEnd = (end: typeof handover.from): EndChoice | undefined => {
      const node = end === undefined ? undefined : loaded.nodes.find((candidate) => elementKey(candidate.ref) === elementKey(end));
      return node === undefined ? undefined : choiceOf(node);
    };
    setFrom(loadedEnd(handover.from));
    setTo(loadedEnd(handover.to));
    run.clear();
    state.presentation.clearPathsHandover();
    // taken once: the panel reads the hand-over when it appears or when another one arrives
  }, [handover]);
  const choose = (result: PathsOk, position: number): void => {
    if (sourceId === null || principalId === undefined) return;
    setChosen({ result, position, outcome: choosePath(state, elementsOf(result, position), { sourceId, principalId, mask: run.ask?.mask === true }) });
  };
  const shownChoice = chosen !== undefined && chosen.result === run.result ? chosen : undefined;
  const evidenceOf = (step: PathsOk['paths'][number]['steps'][number], reference: string): (() => void) | undefined => {
    if (evidence === undefined || run.result === undefined) return undefined;
    const edge = edgeOfStep(run.result, step);
    if (edge === undefined || !edge.evidenceRefs.includes(reference)) return undefined;
    const drawn = new Set(partitionEdges(visible).drawable.map((candidate) => edgeKey(candidate.ref)));
    return drawn.has(edgeKey(edge.ref)) ? () => void evidence.open(edge.ref) : undefined;
  };

  return (
    <div className="patterns-panel paths-panel" ref={root}>
      <div className="search-panel-header">
        <h2 className="search-panel-heading">{PATHS_COPY.title}</h2>
        <button type="button" className="legend-close" aria-label={PATHS_COPY.close} onClick={close}>
          <span className="icon icon-clear" aria-hidden="true" />
        </button>
      </div>
      {sourceId === null ? (
        <p className="search-panel-note">{NO_SOURCE_TEXT}</p>
      ) : (
        <>
          <EndField client={client} sourceId={sourceId} mask={mask} id="paths-from" label={PATHS_COPY.from} candidates={candidates} chosen={from} selectRef={fromField} onChoose={(choice) => (setFrom(choice), changed())} />
          <EndField client={client} sourceId={sourceId} mask={mask} id="paths-to" label={PATHS_COPY.to} candidates={candidates} chosen={to} onChoose={(choice) => (setTo(choice), changed())} />
          <div className="patterns-field">
            <label htmlFor="paths-hops">{PATHS_COPY.maxHops}</label>
            <input id="paths-hops" className="patterns-input" type="number" min={1} value={maxHops} onChange={(event) => (setMaxHops(Math.max(1, Math.floor(Number(event.target.value)) || 1)), changed())} />
          </div>
          <div className="patterns-field">
            <label htmlFor="paths-direction">{PATHS_COPY.direction}</label>
            <select id="paths-direction" className="patterns-input" value={direction} onChange={(event) => (setDirection(DIRECTIONS.find((way) => way === event.target.value) ?? 'both'), changed())}>
              {DIRECTIONS.map((way) => (
                <option key={way} value={way}>
                  {DIRECTION_LABELS[way]}
                </option>
              ))}
            </select>
          </div>
          <div className="patterns-field">
            <label htmlFor="paths-limit">{PATHS_COPY.limit}</label>
            <input id="paths-limit" className="patterns-input" type="number" min={1} value={limit} onChange={(event) => (setLimit(Math.max(1, Math.floor(Number(event.target.value)) || 1)), changed())} />
          </div>
          <fieldset className="patterns-field paths-types">
            <legend>{PATHS_COPY.relationships}</legend>
            {types.map((type) => (
              <label key={type} className="paths-type">
                <input
                  type="checkbox"
                  checked={!off.has(type)}
                  onChange={(event) => {
                    setOff((previous) => new Set(event.target.checked ? [...previous].filter((entry) => entry !== type) : [...previous, type]));
                    changed();
                  }}
                />
                {type}
              </label>
            ))}
          </fieldset>
          {source?.timeoutMs === undefined ? null : <p className="search-panel-note">{timeoutLabel(source.timeoutMs)}</p>}
          <div className="patterns-actions">
            {run.running ? (
              <button type="button" className="secondary" onClick={run.cancel}>
                {PATHS_COPY.cancel}
              </button>
            ) : (
              <button type="button" className="primary" disabled={problem !== undefined} aria-describedby={problem === undefined ? undefined : 'paths-problem'} onClick={find}>
                {PATHS_COPY.find}
              </button>
            )}
          </div>
          {problem === undefined ? null : (
            <p id="paths-problem" className="search-panel-note">
              {PROBLEM_TEXT[problem]}
            </p>
          )}
          {run.failure === undefined ? null : (
            <p className="search-panel-note" role="alert">
              {failureText(run.failure)}
              {run.failure.code === 'QUERY_BUDGET_EXCEEDED' ? null : (
                <>
                  {' '}
                  <button type="button" className="secondary" onClick={() => (run.ask === undefined ? undefined : run.run(run.ask))}>
                    {RETRY_LABEL}
                  </button>
                </>
              )}
            </p>
          )}
          {run.result === undefined ? null : (
            <div className="paths-result" ref={listRef}>
              <p className="search-panel-note" role="status">
                {summaryText(run.result.paths.length, run.result.elapsedMs, run.result.capReached, run.result.partial)}
              </p>
              {run.result.paths.length === 0 ? <p className="search-panel-note">{noPathText(run.ask?.maxHops ?? maxHops)}</p> : <PathList result={run.result} chosen={shownChoice?.position} onChoose={(position) => (run.result === undefined ? undefined : choose(run.result, position))} evidenceOf={evidenceOf} />}
              {shownChoice === undefined || shownChoice.outcome.hiddenEntities === 0 ? null : <p className="search-panel-note">{hiddenByFiltersText(shownChoice.outcome.hiddenEntities)}</p>}
            </div>
          )}
        </>
      )}
    </div>
  );
}
