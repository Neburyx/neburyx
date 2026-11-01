import { searchGraph } from '../sources/neo4j-adapter.js';

export function build(): string {
  return searchGraph();
}
