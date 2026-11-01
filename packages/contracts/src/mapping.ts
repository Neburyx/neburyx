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

export const PRESET_TEMPLATES = ['shared-attribute', 'linked-entities'] as const;

export type PresetTemplate = (typeof PRESET_TEMPLATES)[number];

export const presetTemplateSchema = z.enum(PRESET_TEMPLATES);
