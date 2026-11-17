import { z } from 'zod';

/** The keys a user may store; a later epic adds a key by adding it here. */
export const PREFERENCE_KEYS = ['tour'] as const;

export const tourPreferenceSchema = z.enum(['completed', 'skipped']);

export const preferencesSchema = z.strictObject({ tour: tourPreferenceSchema.optional() });
export const preferencesResponseSchema = z.strictObject({ preferences: preferencesSchema });
export const preferencesWriteRequestSchema = z.strictObject({ preferences: preferencesSchema });

export type Preferences = z.infer<typeof preferencesSchema>;
export type PreferencesResponse = z.infer<typeof preferencesResponseSchema>;
export type PreferencesWriteRequest = z.infer<typeof preferencesWriteRequestSchema>;
