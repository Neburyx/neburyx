import { searchGraph } from '../sources/neo4j-adapter.js';

export function run(): string {
  return searchGraph();
}
