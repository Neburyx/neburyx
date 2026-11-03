/** Adapter name to the package.json files whose versions a report records, relative to the package root. */
export const ADAPTER_PACKAGES: Readonly<Record<string, readonly string[]>> = {
  cytoscape: ['node_modules/cytoscape/package.json'],
  sigma: ['node_modules/sigma/package.json', 'node_modules/graphology/package.json', 'node_modules/graphology-layout-forceatlas2/package.json'],
};
