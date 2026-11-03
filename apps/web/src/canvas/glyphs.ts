import type { IconKey } from '@neburyx/contracts';
import building from '../assets/lucide/building-2.svg?raw';
import car from '../assets/lucide/car.svg?raw';
import circleDot from '../assets/lucide/circle-dot.svg?raw';
import fileText from '../assets/lucide/file-text.svg?raw';
import folder from '../assets/lucide/folder.svg?raw';
import globe from '../assets/lucide/globe.svg?raw';
import house from '../assets/lucide/house.svg?raw';
import landmark from '../assets/lucide/landmark.svg?raw';
import monitor from '../assets/lucide/monitor.svg?raw';
import phone from '../assets/lucide/phone.svg?raw';
import shield from '../assets/lucide/shield.svg?raw';
import store from '../assets/lucide/store.svg?raw';
import user from '../assets/lucide/user.svg?raw';
import wrench from '../assets/lucide/wrench.svg?raw';

export const GLYPHS: Readonly<Record<IconKey, string>> = {
  generic: circleDot,
  person: user,
  organization: building,
  terminal: monitor,
  network: globe,
  document: fileText,
  money: landmark,
  storefront: store,
  telephone: phone,
  house,
  car,
  wrench,
  shield,
  folder,
};

/** The glyph as an image the renderer can draw: the library's files take their colour from `currentColor`, which an image cannot inherit, so the colour is written in. */
export function glyphUri(key: IconKey, color: string): string {
  return `data:image/svg+xml;utf8,${encodeURIComponent(GLYPHS[key].replaceAll('currentColor', color))}`;
}
