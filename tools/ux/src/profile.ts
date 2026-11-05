/** Which limits a browser test holds: the product figures of the recorded laptop, or the ones chosen from measurements of the CI runner. */
export type Profile = 'laptop' | 'runner';

/**
 * The profile a run asks for, by its own variable, `NEBURYX_UX_PROFILE`: `runner` in the ux job, nothing or `laptop` everywhere else. A value that is neither is an error,
 * so that a typo can never select the looser limits, and a shell that happens to set `CI` selects nothing.
 */
export function profileFrom(env: Readonly<Record<string, string | undefined>>): Profile {
  const value = env['NEBURYX_UX_PROFILE'];
  if (value === undefined || value === '' || value === 'laptop') return 'laptop';
  if (value === 'runner') return 'runner';
  throw new Error(`NEBURYX_UX_PROFILE is ${JSON.stringify(value)}; it is "laptop" or "runner"`);
}
