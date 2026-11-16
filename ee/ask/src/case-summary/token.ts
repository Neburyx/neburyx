import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import type { SummarySentence } from '@neburyx/contracts';
import type { NotesTemplate } from './notes-convert.js';
import type { TokenKey, TokenKeys } from './token-keys.js';

/** How long a token is valid after it was drafted, in milliseconds. */
export const TOKEN_LIFETIME_MS = 30 * 60 * 1000;

const VERSION = 'v1';
const IV_BYTES = 12;
const ALGORITHM = 'aes-256-gcm';

interface TokenInputRef {
  readonly key: string;
  readonly kind: 'entity' | 'relationship';
  readonly ref: unknown;
}

/** What the token holds: who drafted what, for which investigation and policy, and the sentences as the model wrote them. */
interface TokenPayload {
  readonly tokenId: string;
  readonly investigationId: string;
  readonly generatedBy: string;
  readonly policyVersion: string;
  readonly generatedAt: number;
  readonly expiresAt: number;
  readonly modelRef: string;
  readonly promptId: string;
  readonly promptVersion: string;
  readonly sentences: readonly SummarySentence[];
  readonly inputRefs: readonly TokenInputRef[];
  readonly propertyValuesSent: boolean;
  /** The id of the stored record of the click, for the audit event of a copy. */
  readonly runId: string;
  /** Whether the generation masked the personal data of its elements. */
  readonly mask: boolean;
  /** The version of the word list the templates were made under; a copy under another version is refused. */
  readonly wordListVersion: number;
  /** What each sentence becomes as AI notes, in the order of `sentences`. */
  readonly templates: readonly NotesTemplate[];
}

export type SealInput = Omit<TokenPayload, 'tokenId' | 'generatedAt' | 'expiresAt'>;

const b64 = (bytes: Buffer): string => bytes.toString('base64url');

/** Seals a draft under the current key: AES-256-GCM, the key's `kid` in the header and authenticated with the text. */
export function sealToken(keys: TokenKeys, input: SealInput, now: number): string {
  const payload: TokenPayload = { ...input, tokenId: randomUUID(), generatedAt: now, expiresAt: now + TOKEN_LIFETIME_MS };
  const iv = randomBytes(IV_BYTES);
  const header = `${VERSION}.${keys.current.kid}`;
  const cipher = createCipheriv(ALGORITHM, keys.current.bytes, iv);
  cipher.setAAD(Buffer.from(header, 'utf8'));
  const sealed = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  return `${header}.${b64(iv)}.${b64(sealed)}.${b64(cipher.getAuthTag())}`;
}

export interface OpenContext {
  readonly investigationId: string;
  readonly actorId: string;
  readonly policyVersion: string;
  readonly now: number;
}

export type OpenedToken = { readonly ok: true; readonly payload: TokenPayload } | { readonly ok: false };

const keyFor = (keys: TokenKeys, kid: string): TokenKey | undefined => [keys.current, keys.previous].find((key) => key?.kid === kid);

function isPayload(value: unknown): value is TokenPayload {
  return typeof value === 'object' && value !== null && 'tokenId' in value && 'investigationId' in value && 'generatedBy' in value && 'policyVersion' in value && 'expiresAt' in value && 'sentences' in value && 'inputRefs' in value && 'propertyValuesSent' in value && 'templates' in value && 'runId' in value && 'mask' in value && 'wordListVersion' in value;
}

/** Opens a token for one investigation, person and policy version: a changed byte, another investigation, another person, a changed policy version, an expired token or an unknown key is refused alike, with nothing said of which. */
export function openToken(keys: TokenKeys, token: string, context: OpenContext): OpenedToken {
  const parts = token.split('.');
  if (parts.length !== 5 || parts[0] !== VERSION) return { ok: false };
  const [version, kid, ivText, sealedText, tagText] = parts as [string, string, string, string, string];
  const key = keyFor(keys, kid);
  if (key === undefined) return { ok: false };
  try {
    const decipher = createDecipheriv(ALGORITHM, key.bytes, Buffer.from(ivText, 'base64url'));
    decipher.setAAD(Buffer.from(`${version}.${kid}`, 'utf8'));
    decipher.setAuthTag(Buffer.from(tagText, 'base64url'));
    const payload: unknown = JSON.parse(Buffer.concat([decipher.update(Buffer.from(sealedText, 'base64url')), decipher.final()]).toString('utf8'));
    if (!isPayload(payload)) return { ok: false };
    if (payload.expiresAt <= context.now || payload.investigationId !== context.investigationId || payload.generatedBy !== context.actorId || payload.policyVersion !== context.policyVersion) return { ok: false };
    return { ok: true, payload };
  } catch {
    return { ok: false };
  }
}
