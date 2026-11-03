import type { SourceProfile } from '@neburyx/contracts';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useClientState, useLoadedGraph } from '../state/context.js';
import { useStoreSelector } from '../state/store.js';
import { formatNumber } from '../workspace/scope-text.js';
import { buildScene } from './build-scene.js';
import { captionFontsReady, loadCaptionFonts } from './fonts.js';
import { useCreateRenderer } from './renderer-context.js';
import type { CanvasRenderer, Scene } from './scene.js';

export const RENDERER_UNAVAILABLE = 'RENDERER_UNAVAILABLE';

const counted = (value: number, one: string, many: string): string => `${formatNumber(value)} ${value === 1 ? one : many}`;

export function GraphCanvas({ profile, view = 'fit' }: { readonly profile?: SourceProfile | undefined; readonly view?: Scene['view'] }) {
  const createRenderer = useCreateRenderer();
  const state = useClientState();
  const graph = useLoadedGraph();
  const positions = useStoreSelector(state.presentation.view, (current) => current.positions);
  const scene = useMemo(() => buildScene(graph, positions, profile, view), [graph, positions, profile, view]);
  const container = useRef<HTMLDivElement>(null);
  const [renderer, setRenderer] = useState<CanvasRenderer | undefined>(undefined);
  const [failed, setFailed] = useState(false);
  const descriptionId = useId();

  useEffect(() => {
    let created: CanvasRenderer | undefined;
    try {
      created = createRenderer();
      created.mount(container.current ?? undefined);
    } catch {
      // the notice names the stable code; the library's own message is not shown
      created?.dispose();
      setFailed(true);
      return undefined;
    }
    const mounted = created;
    setFailed(false);
    setRenderer(mounted);
    return () => {
      mounted.dispose();
      setRenderer(undefined);
    };
  }, [createRenderer]);

  useEffect(() => {
    if (renderer === undefined) return undefined;
    let current = true;
    const draw = (): void => {
      if (!current) return;
      try {
        for (const [id, position] of renderer.draw(scene)) state.presentation.setPosition(id, position);
        setFailed(false);
      } catch {
        // the notice names the stable code; the library's own message is not shown
        setFailed(true);
      }
    };
    if (captionFontsReady()) draw();
    else void loadCaptionFonts().then(draw, draw);
    return () => {
      current = false;
    };
  }, [renderer, scene, state]);

  return (
    <>
      <div ref={container} className="graph-canvas" role="img" aria-label="Graph canvas" aria-describedby={descriptionId} />
      <p id={descriptionId} className="visually-hidden">
        {counted(graph.nodes.length, 'entity', 'entities')} and {counted(graph.edges.length, 'relationship', 'relationships')} loaded
        {scene.omitted === 0 ? '' : `; ${counted(scene.omitted, 'relationship is', 'relationships are')} not drawn because an entity ${scene.omitted === 1 ? 'it joins' : 'they join'} is not loaded`}
      </p>
      {failed ? (
        <p role="alert" className="canvas-notice">
          {RENDERER_UNAVAILABLE}
        </p>
      ) : null}
    </>
  );
}
