import { randomBytes } from 'node:crypto';
import { DATABASE_PREFIX, USER_PREFIX } from './settings.js';

/** How long an object stays before a sweep may remove it: longer than any test run, so a sweep never removes what a run in progress made. */
export const STALE_AFTER_MS = 3 * 60 * 60 * 1000;

export interface RunNames {
  readonly id: string;
  readonly database: string;
  /** The login and role of a kind: `reader` or `writer`. */
  readonly login: (kind: LoginKind) => string;
  readonly role: (kind: LoginKind) => string;
}

export type LoginKind = 'reader' | 'writer';

/** The names of what one server start creates; the time is in them so that a sweep can tell a leftover from a run in progress. */
export function namesFor(now: number = Date.now(), random: () => string = () => randomBytes(3).toString('hex')): RunNames {
  const stamp = now.toString(36);
  const salt = random();
  const id = `${stamp}-${salt}`;
  return {
    id,
    database: `${DATABASE_PREFIX}${id}`,
    login: (kind) => `${USER_PREFIX}${stamp}_${salt}_${kind}`,
    role: (kind) => `${USER_PREFIX}${stamp}_${salt}_${kind}_role`,
  };
}

const DATABASE = new RegExp(`^${DATABASE_PREFIX}([0-9a-z]+)-[0-9a-f]{6}$`);
const OBJECT = new RegExp(`^${USER_PREFIX}([0-9a-z]+)_[0-9a-f]{6}_(?:reader|writer)(?:_role)?$`);

function stampOf(match: RegExpExecArray | null): number | undefined {
  const stamp = match?.[1];
  if (stamp === undefined) return undefined;
  const time = parseInt(stamp, 36);
  return Number.isFinite(time) ? time : undefined;
}

/** True only for a database named exactly as this module names one, made more than `STALE_AFTER_MS` ago. */
export function isStaleDatabase(name: string, now: number = Date.now()): boolean {
  const time = stampOf(DATABASE.exec(name));
  return time !== undefined && now - time > STALE_AFTER_MS;
}

/** True only for a login or role named exactly as this module names one, made more than `STALE_AFTER_MS` ago. */
export function isStaleObject(name: string, now: number = Date.now()): boolean {
  const time = stampOf(OBJECT.exec(name));
  return time !== undefined && now - time > STALE_AFTER_MS;
}

/** True for a database this module could have named, current or stale. */
export const isTestDatabase = (name: string): boolean => DATABASE.test(name);
