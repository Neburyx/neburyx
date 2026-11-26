import { useEffect, useMemo, useRef, useState } from 'react';
import type { GraphNode, PathsOk } from '@neburyx/contracts';
import { SearchFailed, useEntitySearch } from '../patterns/start-entity.js';
import type { ApiClient } from '../api/client.js';
import { withoutReadsWhileSourceChanged } from '../api/changed-source-guard.js';
import { useApiClient } from '../api/client-context.js';
import { useProfile } from '../canvas/profile-context.js';
import { answeredData, useShellData } from '../shell/shell-data.js';
import { useClientState, useLoadedGraph, useSessionMask, useVisibleGraph } from '../state/context.js';
import { partitionEdges } from '../state/loaded-graph.js';
import { edgeKey, elementKey } from '../state/keys.js';
import { useStoreSelector } from '../state/store.js';
import { DIRECTION_LABELS, failureText, evidenceLabel, FAILED_TEXT, hiddenByFiltersText, SELECTED_LABEL, NO_SOURCE_TEXT, noPathText, PATHS_COPY, pathTitle, PROBLEM_TEXT, RETRY_LABEL, summaryText, timeoutLabel } from './copy.js';
import { useEvidenceHandle } from '../patterns/evidence-handle.js';
import { addPath, highlightPath, missingOf, type ChosenOutcome } from './choose-path.js';
import { edgeOfStep, elementsOf } from './path-elements.js';
import { useBanner } from '../banner/banner-context.js';
import { usePathsEnvironment } from './paths-context.js';
import { choiceOf, DEFAULT_LIMIT, LIMIT_CHOICES, initialForm, problemOf, relationshipTypesOf, requestOf, type EndChoice, type PathsForm } from './paths-form.js';
import { focusPathsTool } from './paths-tool.js';
import { usePathsRun } from './use-paths-run.js';

const DIRECTIONS = ['both', 'out', 'in'] as const;
const PANEL_GAP = 16;
const MAX_HOPS_CEILING = 4;

interface EndFieldProps {
  readonly client: ApiClient;
  readonly sourceId: string;
  readonly mask: boolean;
  readonly id: string;
  readonly label: string;
  readonly candidates: readonly GraphNode[];
  readonly chosen: EndChoice | undefined;
  readonly onChoose: (choice: EndChoice | undefined) => void;
  readonly inputRef?: React.Ref<HTMLInputElement>;
}

const LOCAL_OPTIONS = 8;

/** An end is one search field: it lists the loaded entities that fit what is typed, the selected ones first, and then what the source finds. */
function EndField({ client, sourceId, mask, id, label, candidates, chosen, onChoose, inputRef }: EndFieldProps) {
  const [text, setText] = useState<string | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const typed = text ?? '';
  const { found, asked, earlier, retry } = useEntitySearch(client, sourceId, mask, undefined, typed);
  const query = typed.trim().toLowerCase();
  const local = candidates.filter((node) => query === '' || node.display.title.toLowerCase().includes(query)).slice(0, LOCAL_OPTIONS);
  const loadedKeys = new Set(candidates.map((node) => elementKey(node.ref)));
  const searched = found.kind === 'found' ? found.nodes : found.kind === 'failed' ? earlier : [];
  const hits = searched.filter((node) => !loadedKeys.has(elementKey(node.ref)));
  const options = [...local, ...hits];
  const listId = `${id}-options`;
  const pick = (node: GraphNode): void => {
    onChoose(choiceOf(node));
    setText(undefined);
    setOpen(false);
  };
  return (
    <div className="patterns-field paths-end">
      <label htmlFor={id}>{label}</label>
      <div
        className="paths-search"
        onBlur={(event) => {
          if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
          if (text !== undefined && text.trim() === '') onChoose(undefined);
          setText(undefined);
          setOpen(false);
        }}
      >
        <span className="icon icon-find paths-search-icon" aria-hidden="true" />
        <input
          id={id}
          ref={inputRef}
          type="text"
          role="combobox"
          className="patterns-input paths-search-input"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open && options[active] !== undefined ? `${id}-option-${active}` : undefined}
          placeholder={PATHS_COPY.searchLabel}
          autoComplete="off"
          value={text ?? chosen?.title ?? ''}
          onFocus={() => setOpen(true)}
          onChange={(event) => {
            setText(event.target.value);
            setActive(0);
            setOpen(true);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              if (open) setOpen(false);
            } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault();
              setOpen(true);
              setActive((current) => Math.min(Math.max(current + (event.key === 'ArrowDown' ? 1 : -1), 0), Math.max(options.length - 1, 0)));
            } else if (event.key === 'Enter' && open && options[active] !== undefined) {
              event.preventDefault();
              pick(options[active]);
            }
          }}
        />
        {open && options.length > 0 ? (
          <ul id={listId} role="listbox" aria-label={`${label} results`} className="paths-options">
            {options.map((node, index) => (
              <li key={elementKey(node.ref)} id={`${id}-option-${index}`} role="option" aria-selected={index === active} className="paths-option" onMouseDown={(event) => event.preventDefault()} onClick={() => pick(node)}>
                {index < local.length ? node.display.title : `${node.display.title} (${node.display.type})`}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      {found.kind === 'failed' ? (
        <SearchFailed text={PATHS_COPY.searchFailed} failure={found.failure} retry={retry} />
      ) : asked && found.kind === 'found' && found.nodes.length === 0 && local.length === 0 ? (
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
  /** How many entities and relationships of the chosen path are not loaded now. */
  readonly missing: number | undefined;
  readonly onChoose: (position: number) => void;
  readonly onAdd: () => void;
  /** The opener of the evidence of a step's relationship, when it is on the canvas and a kind of evidence offers it. */
  readonly evidenceOf: (step: PathsOk['paths'][number]['steps'][number], reference: string) => (() => void) | undefined;
}

function PathList({ result, chosen, missing, onChoose, onAdd, evidenceOf }: PathListProps) {
  const titles = titlesOf(result);
  const titleOf = (ref: PathsOk['paths'][number]['steps'][number]['from']): string => titles.get(elementKey(ref)) ?? ref.stableId;
  return (
    <ol className="paths-list" aria-label={PATHS_COPY.results}>
      {result.paths.map((path, position) => (
        <li key={position} className="paths-card" data-selected={chosen === position ? 'true' : undefined}>
          <h3 className="paths-card-title">
            <button type="button" className="paths-choose" aria-pressed={chosen === position} onClick={() => onChoose(position)}>
              {pathTitle(position + 1, path.hops)}
            </button>
            {chosen === position ? <span className="paths-selected"> · {SELECTED_LABEL}</span> : null}
          </h3>
          <ol className="paths-steps" aria-label={PATHS_COPY.steps}>
            {path.steps.map((step, index) => (
              <li key={index}>
                <span className="paths-step">
                  {titleOf(step.from)} → {titleOf(step.to)}
                </span>
                {step.evidenceRefs.map((reference) => {
                  const open = chosen === position ? evidenceOf(step, reference) : undefined;
                  return open === undefined ? (
                    <span key={reference} className="paths-evidence">
                      {evidenceLabel(reference, false)}
                    </span>
                  ) : (
                    <button key={reference} type="button" className="paths-evidence-open" onClick={open}>
                      {evidenceLabel(reference, true)}
                    </button>
                  );
                })}
              </li>
            ))}
          </ol>
          {chosen === position && missing !== undefined ? (
            <button type="button" className="secondary paths-add" disabled={missing === 0} onClick={onAdd}>
              {missing === 0 ? PATHS_COPY.onCanvas : PATHS_COPY.addToGraph}
            </button>
          ) : null}
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
  const sourceMaxHops = source?.maxHops;
  const options = useMemo(() => ({ ...(report === undefined ? {} : { report }), ...(tracker === undefined ? {} : { tracker }), banner, timeoutMs: () => timeoutOfSource, focus: (target: 'from' | 'list') => state.presentation.requestPathsFocus(target) }), [report, tracker, banner, timeoutOfSource, state]);
  const run = usePathsRun(open, `${sourceId ?? ''}\u0000${investigationId ?? ''}\u0000${mask}`, client, sourceId ?? '', options);
  const [from, setFrom] = useState<EndChoice | undefined>(undefined);
  const [to, setTo] = useState<EndChoice | undefined>(undefined);
  const [maxHops, setMaxHops] = useState<number>(() => initialForm(source?.maxHops, types).maxHops);
  const [direction, setDirection] = useState<PathsForm['direction']>('both');
  const [limit, setLimit] = useState<number>(DEFAULT_LIMIT);
  const [off, setOff] = useState<ReadonlySet<string>>(new Set());
  const [typesOpen, setTypesOpen] = useState(false);
  const [chosen, setChosen] = useState<{ readonly result: PathsOk; readonly position: number; readonly outcome: ChosenOutcome } | undefined>(undefined);
  const evidence = useEvidenceHandle();
  const visible = useVisibleGraph();
  const principalId = answeredData(shell.me)?.principal.id;
  const listRef = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const fromField = useRef<HTMLInputElement>(null);
  const typesToggle = useRef<HTMLButtonElement>(null);
  const escape = useRef<() => void>(() => undefined);

  const hopChoices = Array.from({ length: Math.max(sourceMaxHops ?? MAX_HOPS_CEILING, maxHops) }, (_, index) => index + 1);
  const form: PathsForm = { from, to, maxHops, direction, limit, relTypes: new Set(types.filter((type) => !off.has(type))) };
  const problem = problemOf(form);
  const candidates = useMemo(() => [...loaded.nodes].sort((left, right) => Number(selection.has(elementKey(right.ref))) - Number(selection.has(elementKey(left.ref)))), [loaded, selection]);
  const close = (): void => {
    state.presentation.setPathsOpen(false);
    focusPathsTool();
  };
  escape.current = run.running ? run.cancel : close;
  useEffect(() => {
    if (sourceMaxHops !== undefined) setMaxHops((current) => Math.min(current, sourceMaxHops));
  }, [sourceMaxHops]);

  useEffect(() => {
    const frame = root.current?.closest('.panel-frame');
    if (frame === null || frame === undefined) return undefined;
    const onKey = (event: Event): void => {
      if (!(event instanceof KeyboardEvent) || event.key !== 'Escape') return;
      if (frame.querySelector('.paths-options, .paths-types-menu') !== null) return;
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
  const clearOfX = (): number => (root.current?.closest('.panel-frame')?.getBoundingClientRect().right ?? 0) + PANEL_GAP;
  const choose = (result: PathsOk, position: number): void => {
    setChosen({ result, position, outcome: highlightPath(state, elementsOf(result, position), clearOfX()) });
  };
  const add = (): void => {
    if (sourceId === null || principalId === undefined || chosen === undefined || chosen.result !== run.result) return;
    setChosen({ ...chosen, outcome: addPath(state, elementsOf(chosen.result, chosen.position), { sourceId, principalId, mask: run.ask?.mask === true, clearOfX: clearOfX() }) });
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
          <EndField client={client} sourceId={sourceId} mask={mask} id="paths-from" label={PATHS_COPY.from} candidates={candidates} chosen={from} inputRef={fromField} onChoose={(choice) => (setFrom(choice), changed())} />
          <EndField client={client} sourceId={sourceId} mask={mask} id="paths-to" label={PATHS_COPY.to} candidates={candidates} chosen={to} onChoose={(choice) => (setTo(choice), changed())} />
          <div className="paths-row">
            <div className="patterns-field">
              <label htmlFor="paths-hops">{PATHS_COPY.maxHops}</label>
              <select id="paths-hops" className="select-control" value={maxHops} onChange={(event) => (setMaxHops(Number(event.target.value)), changed())}>
                {hopChoices.map((hops) => (
                  <option key={hops} value={hops}>
                    {hops}
                  </option>
                ))}
              </select>
            </div>
            <div className="patterns-field">
              <label htmlFor="paths-direction">{PATHS_COPY.direction}</label>
              <select id="paths-direction" className="select-control" value={direction} onChange={(event) => (setDirection(DIRECTIONS.find((way) => way === event.target.value) ?? 'both'), changed())}>
                {DIRECTIONS.map((way) => (
                  <option key={way} value={way}>
                    {DIRECTION_LABELS[way]}
                  </option>
                ))}
              </select>
            </div>
            <div className="patterns-field">
              <label htmlFor="paths-limit">{PATHS_COPY.limit}</label>
              <select id="paths-limit" className="select-control" value={limit} onChange={(event) => (setLimit(Number(event.target.value)), changed())}>
                {LIMIT_CHOICES.map((cap) => (
                  <option key={cap} value={cap}>
                    {cap}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div
            className="patterns-field paths-types"
            onKeyDown={(event) => {
              if (event.key !== 'Escape' || !typesOpen) return;
              setTypesOpen(false);
              typesToggle.current?.focus();
            }}
          >
            <span id="paths-types-label">{PATHS_COPY.relationships}</span>
            <button type="button" ref={typesToggle} className="paths-types-toggle" aria-labelledby="paths-types-label paths-types-value" aria-expanded={typesOpen} aria-controls="paths-types-menu" onClick={() => setTypesOpen((current) => !current)}>
              <span id="paths-types-value" className="paths-types-value">
                {form.relTypes.size === 0 ? PATHS_COPY.noTypes : types.filter((type) => form.relTypes.has(type)).join(' · ')}
              </span>
              <span className="icon paths-types-chevron" aria-hidden="true" />
            </button>
            {typesOpen ? (
              <div
                id="paths-types-menu"
                role="group"
                aria-labelledby="paths-types-label"
                className="paths-types-menu"
              >
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
              </div>
            ) : null}
          </div>
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
            {source?.timeoutMs === undefined ? null : <span className="search-panel-note">{timeoutLabel(source.timeoutMs)}</span>}
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
              {run.result.paths.length === 0 ? <p className="search-panel-note">{noPathText(run.ask?.maxHops ?? maxHops)}</p> : <PathList result={run.result} chosen={shownChoice?.position} missing={shownChoice === undefined ? undefined : missingOf(loaded, elementsOf(shownChoice.result, shownChoice.position))} onAdd={add} onChoose={(position) => (run.result === undefined ? undefined : choose(run.result, position))} evidenceOf={evidenceOf} />}
              {shownChoice === undefined || shownChoice.outcome.hiddenEntities === 0 ? null : <p className="search-panel-note">{hiddenByFiltersText(shownChoice.outcome.hiddenEntities)}</p>}
            </div>
          )}
        </>
      )}
    </div>
  );
}
