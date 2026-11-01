import { describe, expect, it } from 'vitest';
import { ICON_KEYS, PRESET_TEMPLATES, iconKeySchema, presetTemplateSchema } from './mapping.js';

describe('mapping vocabulary shared with the client', () => {
  it('accepts every icon key and refuses one outside the fixed set', () => {
    for (const key of ICON_KEYS) expect(iconKeySchema.safeParse(key).success).toBe(true);
    expect(iconKeySchema.safeParse('sparkle').success).toBe(false);
  });

  it('starts the icon keys with the generic default', () => {
    expect(ICON_KEYS[0]).toBe('generic');
  });

  it('accepts only the built-in preset templates', () => {
    for (const name of PRESET_TEMPLATES) expect(presetTemplateSchema.safeParse(name).success).toBe(true);
    expect(presetTemplateSchema.safeParse('free-form').success).toBe(false);
  });
});
