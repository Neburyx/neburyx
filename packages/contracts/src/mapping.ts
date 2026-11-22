import { z } from 'zod';

export const ICON_KEYS = [
  'generic',
  'person',
  'organization',
  'terminal',
  'network',
  'document',
  'money',
  'storefront',
  'telephone',
  'house',
  'car',
  'wrench',
  'shield',
  'folder',
] as const;

export type IconKey = (typeof ICON_KEYS)[number];

export const iconKeySchema = z.enum(ICON_KEYS);

/** The tones a style rule's badge or colour may take, named for the design tokens they stand for: caution, danger, success, accent and neutral. */
export const STYLE_TONES = ['amber', 'red', 'green', 'blue', 'gray'] as const;

export type StyleTone = (typeof STYLE_TONES)[number];

export const STYLE_OPERATORS = ['eq', 'in', 'gt', 'gte', 'lt', 'lte', 'between'] as const;

export type StyleOperator = (typeof STYLE_OPERATORS)[number];

export const STYLE_EFFECT_KINDS = ['badge', 'color', 'icon', 'size'] as const;

export type StyleEffectKind = (typeof STYLE_EFFECT_KINDS)[number];

/** The longest label of a style rule, in characters: the legend shows it on one line. */
export const MAX_STYLE_LABEL = 80;

export const PRESET_TEMPLATES = ['shared-attribute', 'linked-entities'] as const;

export type PresetTemplate = (typeof PRESET_TEMPLATES)[number];

export const presetTemplateSchema = z.enum(PRESET_TEMPLATES);

/** The classes a `pii` field may be given in the mapping; the class only picks the shape of its mask. */
export const PII_CLASSES = ['name', 'email', 'phone', 'date', 'text'] as const;

export type PiiClass = (typeof PII_CLASSES)[number];

export const piiClassSchema = z.enum(PII_CLASSES);

