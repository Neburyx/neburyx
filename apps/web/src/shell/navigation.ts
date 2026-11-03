export const EXPLORE_PATH = '/explore';

export interface NavigationItem {
  readonly to: string;
  readonly label: string;
  readonly icon: string;
  readonly end: boolean;
  readonly alsoCurrentOn?: readonly string[];
}

export const NAVIGATION: readonly NavigationItem[] = [
  { to: '/', label: 'Home', icon: 'icon-home', end: true },
  { to: '/investigations', label: 'Investigations', icon: 'icon-investigations', end: false, alsoCurrentOn: [EXPLORE_PATH] },
  { to: '/sources', label: 'Sources', icon: 'icon-sources', end: false },
];
