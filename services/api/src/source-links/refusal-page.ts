import { createHash } from 'node:crypto';

const STYLE = 'body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;font:16px/1.5 system-ui,sans-serif;color:#1f2430;background:#f7f8fa}main{max-width:28rem;padding:2rem;text-align:center}p{margin:0 0 .75rem}small{color:#5b6270}';

const styleHash = createHash('sha256').update(STYLE).digest('base64');

/** No script, no outside load, no framing, and only the one inline style this page holds. */
export const REFUSAL_PAGE_CSP = `default-src 'none'; style-src 'sha256-${styleHash}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;

export const REFUSAL_TEXT = "This source record can't be opened from Neburyx.";

const escaped = (text: string): string => text.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);

/** The page every refused source link shows: the same words for every reason, and the trace ID, which says nothing about the record, for support. */
export function refusalPage(traceId: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Source record not opened</title><style>${STYLE}</style></head><body><main><p>${REFUSAL_TEXT}</p><p><small>Reference ${escaped(traceId)}</small></p></main></body></html>`;
}

/** A request that asks for JSON and does not ask for a page (a script, not a person's tab) keeps the JSON error. */
export function asksForJsonOnly(accept: string | string[] | undefined): boolean {
  const text = (Array.isArray(accept) ? accept.join(',') : (accept ?? '')).toLowerCase();
  return text.includes('application/json') && !text.includes('text/html');
}
