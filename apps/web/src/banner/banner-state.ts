export type BannerTone = 'neutral' | 'warning' | 'danger';

export interface BannerAction {
  readonly id: string;
  readonly label: string;
  readonly run: () => void;
  readonly disabled?: boolean;
}

export interface BannerState {
  /** The same ID updates the banner on screen in place; a new one replaces it. */
  readonly id: string;
  readonly tone: BannerTone;
  readonly chip: string;
  readonly headline: string;
  readonly text: string;
  readonly sideLabel?: string;
  readonly actions: readonly BannerAction[];
  /** Whether the banner has a Dismiss button; a state of a request still in flight sets it to false. */
  readonly dismissible?: boolean;
  /** Moves the focus to the banner when it first appears, for a state the person must act on before they go on. */
  readonly moveFocus?: boolean;
  /** Announces an update of the banner already on screen; a new banner is always announced. */
  readonly announce?: boolean;
}
