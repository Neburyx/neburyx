export const BANNER_LABEL = 'Request status';
export const DISMISS = 'Dismiss';
export const PARTIAL_CHIP = 'Partial';
export const PARTIAL_TEXT = 'Partial, not exhaustive · graph preserved.';
export const BUSY_CHIP = 'Busy';
export const busyHeadline = (source: string): string => `${source} is busy. No read slot freed within the wait.`;
export const BUSY_TEXT = 'Loaded graph and filters preserved; nothing was read. Retry when ready.';
export const BUSY_SIDE_LABEL = 'No read slot freed';
export const RETRY = 'Retry';
