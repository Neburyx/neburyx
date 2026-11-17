import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Box } from './anchors.js';
import { dialogName, stepLabel, TOUR_COPY, TOUR_STEPS } from './tour-copy.js';

const POPOVER_WIDTH = 340;
const GAP = 12;
const EDGE = 8;
const SPOT_PAD = 6;
const POPOVER_HEIGHT_GUESS = 220;

export interface OverlayProps {
  readonly step: number;
  /** Measures the anchor now; nothing when it is not on the page. */
  readonly measure: () => Box | undefined;
  readonly onSkip: () => void;
  readonly onBack: () => void;
  readonly onNext: () => void;
}

function place(box: Box | undefined, height: number): { readonly left: number; readonly top: number } {
  const width = window.innerWidth;
  const tall = window.innerHeight;
  if (box === undefined) return { left: Math.max(EDGE, (width - POPOVER_WIDTH) / 2), top: Math.max(EDGE, (tall - height) / 3) };
  const left = Math.min(Math.max(EDGE, box.left), Math.max(EDGE, width - POPOVER_WIDTH - EDGE));
  const below = box.top + box.height + SPOT_PAD + GAP;
  const top = below + height <= tall - EDGE ? below : Math.max(EDGE, box.top - SPOT_PAD - GAP - height);
  return { left, top };
}

export function TourOverlay({ step, measure, onSkip, onBack, onNext }: OverlayProps) {
  const popover = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<Box | undefined>(undefined);
  const [spot, setSpot] = useState<{ readonly left: number; readonly top: number }>({ left: EDGE, top: EDGE });
  const last = step === TOUR_STEPS.length - 1;
  const current = TOUR_STEPS[step];

  useLayoutEffect(() => {
    let frame = 0;
    const update = (): void => {
      frame = 0;
      const next = measure();
      setBox((before) => (before !== undefined && next !== undefined && before.left === next.left && before.top === next.top && before.width === next.width && before.height === next.height ? before : next));
      setSpot(place(next, popover.current?.offsetHeight ?? POPOVER_HEIGHT_GUESS));
    };
    const schedule = (): void => {
      if (frame === 0) frame = requestAnimationFrame(update);
    };
    update();
    window.addEventListener('resize', schedule);
    window.addEventListener('scroll', schedule, true);
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true });
    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      window.removeEventListener('resize', schedule);
      window.removeEventListener('scroll', schedule, true);
      observer.disconnect();
    };
  }, [measure, step]);

  useEffect(() => {
    popover.current?.querySelector<HTMLElement>('[data-tour-primary]')?.focus();
  }, [step]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        // a dialog or menu of the page keeps its own Esc unless the person is working in the tour
        const other = document.querySelector('[role="dialog"]:not(.tour-popover), [role="menu"]');
        if (other !== null && popover.current?.contains(document.activeElement) !== true) return;
        event.preventDefault();
        event.stopPropagation();
        onSkip();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onSkip]);

  const keepWithin = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Tab') return;
    const controls = [...(popover.current?.querySelectorAll<HTMLElement>('button') ?? [])];
    const first = controls[0];
    const final = controls[controls.length - 1];
    if (first === undefined || final === undefined) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      final.focus();
    } else if (!event.shiftKey && document.activeElement === final) {
      event.preventDefault();
      first.focus();
    }
  };

  if (current === undefined) return null;
  return (
    <div className="tour-layer">
      {box === undefined ? (
        <div className="tour-dim" />
      ) : (
        <div className="tour-spot" style={{ left: box.left - SPOT_PAD, top: box.top - SPOT_PAD, width: box.width + SPOT_PAD * 2, height: box.height + SPOT_PAD * 2 }} />
      )}
      <div ref={popover} className="tour-popover" role="dialog" aria-label={dialogName(step)} onKeyDown={keepWithin} style={{ left: spot.left, top: spot.top }}>
        <p className="tour-step">{stepLabel(step)}</p>
        <h2 className="tour-title">{current.title}</h2>
        <p className="tour-body">{current.body}</p>
        <div className="tour-foot">
          <span className="tour-dots" aria-hidden="true">
            {TOUR_STEPS.map((item, index) => (
              <span key={item.title} className={index === step ? 'tour-dot tour-dot-on' : 'tour-dot'} />
            ))}
          </span>
          <span className="tour-actions">
            <button type="button" className="link" onClick={onSkip}>
              {TOUR_COPY.skip}
            </button>
            {step > 0 ? (
              <button type="button" onClick={onBack}>
                {TOUR_COPY.back}
              </button>
            ) : null}
            <button type="button" className="primary" data-tour-primary onClick={onNext}>
              {last ? TOUR_COPY.done : TOUR_COPY.next}
            </button>
          </span>
        </div>
      </div>
    </div>
  );
}

/** The one line shown while the tour waits for an investigation on an install with no demo case. */
export function TourWaiting({ onSkip }: { readonly onSkip: () => void }) {
  return (
    <div className="tour-waiting" role="status">
      <span>{TOUR_COPY.waiting}</span>
      <button type="button" className="link" onClick={onSkip}>
        {TOUR_COPY.skip}
      </button>
    </div>
  );
}
