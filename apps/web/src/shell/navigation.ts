export const EXPLORE_PATH = '/explore';
export const SOURCES_PATH = '/sources';
export const INVESTIGATIONS_PATH = '/investigations';
export const PATTERNS_PATH = '/patterns';

export interface NavigationItem {
  readonly to: string;
  readonly label: string;
  readonly icon: string;
  readonly end: boolean;
  readonly alsoCurrentOn?: readonly string[];
  /** False for a page that Explore's rail does not list, as the design draws it. */
  readonly inRail?: false;
}

export const NAVIGATION: readonly NavigationItem[] = [
  { to: '/', label: 'Home', icon: 'icon-home', end: true },
  { to: '/investigations', label: 'Investigations', icon: 'icon-investigations', end: false, alsoCurrentOn: [EXPLORE_PATH] },
  { to: PATTERNS_PATH, label: 'Patterns', icon: 'icon-patterns', end: false, inRail: false },
  { to: SOURCES_PATH, label: 'Sources', icon: 'icon-sources', end: false },
];
