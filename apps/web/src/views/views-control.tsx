import type { NamedView } from '@neburyx/contracts';
import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { useApiClient } from '../api/client-context.js';
import { BANNER_REGION_CLASS } from '../banner/status-banner.js';
import { useClientState } from '../state/context.js';
import { useStoreSelector } from '../state/store.js';
import { VIEWS_CONTROL } from './copy.js';
import { RestoreConfirm } from './restore-confirm.js';
import { viewListOf } from './view-list.js';
import { ViewsPanel } from './views-panel.js';

/** The space kept between the banner above the canvas and the panel, in pixels. */
const BANNER_GAP_PX = 8;

/** Where the panel starts when a banner is showing: below it, so the banner's own actions stay in reach. */
function clearanceBelowBanner(): number | undefined {
  const bottoms = [...document.querySelectorAll<HTMLElement>(`.${BANNER_REGION_CLASS}`)].filter((region) => (region.textContent ?? '').trim() !== '').map((region) => region.getBoundingClientRect().bottom);
  const lowest = Math.max(0, ...bottoms);
  return lowest > 0 ? Math.ceil(lowest) + BANNER_GAP_PX : undefined;
}

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** The Views control of the header: it opens the Views panel under it, reads the list as it opens, and gives the focus back to itself when the panel closes. */
export function ViewsControl() {
  const state = useClientState();
  const client = useApiClient();
  const investigationId = useStoreSelector(state.investigation, (current) => current.id);
  const shown = useStoreSelector(state.investigation, (current) => current.record !== null);
  const readOnly = useStoreSelector(state.investigation, (current) => current.record?.readOnly === true);
  const [open, setOpen] = useState(false);
  const [top, setTop] = useState<number | undefined>(undefined);
  const [restoring, setRestoring] = useState<NamedView | undefined>(undefined);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const list = viewListOf(state, client);

  useEffect(() => {
    if (!open) return undefined;
    void list.load();
    const onPress = (event: PointerEvent): void => {
      const target = event.target;
      if (target instanceof Node && (panel.current?.contains(target) === true || button.current?.contains(target) === true)) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', onPress);
    return () => document.removeEventListener('pointerdown', onPress);
  }, [open, list]);

  useLayoutEffect(() => {
    if (open) setTop(clearanceBelowBanner());
  }, [open]);

  useEffect(() => {
    if (!open) return;
    (panel.current?.querySelector<HTMLElement>(FOCUSABLE) ?? panel.current)?.focus();
  }, [open]);

  useEffect(() => {
    setOpen(false);
    setRestoring(undefined);
  }, [investigationId]);

  if (!shown) return null;
  const close = (): void => {
    setOpen(false);
    setRestoring(undefined);
    button.current?.focus();
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    close();
  };
  return (
    <div className="views-control">
      <button type="button" ref={button} className="header-link" aria-haspopup="dialog" aria-expanded={open} onClick={() => (open ? close() : setOpen(true))}>
        {VIEWS_CONTROL}
        <span aria-hidden="true"> ▾</span>
      </button>
      {open ? (
        <div className="views-panel" role="dialog" aria-labelledby={titleId} tabIndex={-1} ref={panel} style={top === undefined ? undefined : ({ '--views-panel-top': `${top}px` } as CSSProperties)} onKeyDown={onKeyDown}>
          <ViewsPanel list={list} titleId={titleId} onRestore={setRestoring} readOnly={readOnly} />
        </div>
      ) : null}
      {restoring === undefined ? null : <RestoreConfirm view={restoring} onClose={close} />}
    </div>
  );
}
