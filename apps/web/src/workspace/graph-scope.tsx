import { useLoadedGraph } from '../state/context.js';
import { partitionEdges } from '../state/loaded-graph.js';
import { loadedLine, notDrawnLine, remainderLine, UNKNOWN_REMAINDER } from './scope-text.js';

export function GraphScope() {
  const graph = useLoadedGraph();
  const notDrawn = notDrawnLine(partitionEdges(graph).notDrawable.length);
  return (
    <div className="graph-scope" role="group" aria-label="Graph scope">
      <p>{notDrawn === undefined ? loadedLine(graph) : `${loadedLine(graph)} · ${notDrawn}`}</p>
      <p>{remainderLine(graph.nodes.length, UNKNOWN_REMAINDER)}</p>
    </div>
  );
}
