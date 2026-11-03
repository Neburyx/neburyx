import { useLoadedGraph } from '../state/context.js';
import { loadedLine, remainderLine, UNKNOWN_REMAINDER } from './scope-text.js';

export function GraphScope() {
  const graph = useLoadedGraph();
  return (
    <div className="graph-scope" role="group" aria-label="Graph scope">
      <p>{loadedLine(graph)}</p>
      <p>{remainderLine(graph.nodes.length, UNKNOWN_REMAINDER)}</p>
    </div>
  );
}
