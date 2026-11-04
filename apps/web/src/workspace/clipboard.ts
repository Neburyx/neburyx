export const CLIPBOARD_UNAVAILABLE = 'CLIPBOARD_UNAVAILABLE';

/** Puts text on the clipboard; refused with `CLIPBOARD_UNAVAILABLE` when the browser has none or refuses the write. */
export async function copyText(text: string): Promise<void> {
  try {
    if (navigator.clipboard === undefined) throw new Error(CLIPBOARD_UNAVAILABLE);
    await navigator.clipboard.writeText(text);
  } catch {
    // the notice names the stable code; the browser's own reason is not shown
    throw new Error(CLIPBOARD_UNAVAILABLE);
  }
}
