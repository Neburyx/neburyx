export interface KeyboardActions {
  readonly beforeKey: () => void;
  readonly enter: () => void;
  readonly leave: () => void;
  readonly next: () => void;
  readonly previous: () => void;
  readonly first: () => void;
  readonly last: () => void;
  readonly activate: () => void;
}

function keyOf(event: Event): string | undefined {
  return 'key' in event && typeof event.key === 'string' ? event.key : undefined;
}

/** Every listener ends when the signal aborts, so a disposed canvas leaves none behind. */
export function attachKeyboard(host: EventTarget, document: EventTarget, actions: KeyboardActions, signal: AbortSignal): void {
  const movement: Readonly<Record<string, () => void>> = {
    ArrowRight: actions.next,
    ArrowDown: actions.next,
    ArrowLeft: actions.previous,
    ArrowUp: actions.previous,
    Home: actions.first,
    End: actions.last,
    Enter: actions.activate,
  };
  document.addEventListener('keydown', actions.beforeKey, { capture: true, signal });
  host.addEventListener('focus', actions.enter, { signal });
  host.addEventListener('blur', actions.leave, { signal });
  host.addEventListener(
    'keydown',
    (event) => {
      const key = keyOf(event);
      const action = key !== undefined && Object.hasOwn(movement, key) ? movement[key] : undefined;
      if (action === undefined) return;
      event.preventDefault();
      action();
    },
    { signal },
  );
}
