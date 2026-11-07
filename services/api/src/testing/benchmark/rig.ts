import { createCursorCodec, type CursorCodec, type CursorPosition } from '../../gate/cursor/codec.js';
import { communitySeams } from '../../seams/community-seams.js';
import { createSourceGate, type SourceGate } from '../../gate/source-gate.js';
import { envFor, runAll, sourceFor, startNeo4j, type RunningNeo4j } from '../neo4j-server.js';
import { ALWAYS_USABLE } from '../usability.js';
import { buildSupernodes, ENTITIES, RELATIONSHIPS } from './fixture.js';

/** The graphs of the supernode benchmark behind a real gate, in a database of this run's own. The measurement of a cancelled read is to start from the same rig. */
export interface Rig {
  readonly server: RunningNeo4j;
  readonly parts: SourceGate;
  readonly edition: string;
  /** The position a cursor of this gate holds, as it was when the gate minted the cursor; absent for a cursor it did not mint. */
  readonly positionOf: (cursor: string) => CursorPosition | undefined;
}

/** A codec that signs as the gate's own would and remembers the position of the last 64 cursors it signs (a position is profiled as soon as the walk reaches it), so that a position reached by walking the real chain can be profiled. */
function recordingCodec(): { readonly codec: CursorCodec; readonly positionOf: (cursor: string) => CursorPosition | undefined } {
  const inner = createCursorCodec({ key: Buffer.alloc(32, 7), clock: () => Date.now() });
  const positions = new Map<string, CursorPosition>();
  const KEPT = 64;
  return {
    codec: {
      mint: (binding, position) => {
        const cursor = inner.mint(binding, position);
        positions.set(cursor, position);
        if (positions.size > KEPT) positions.delete(positions.keys().next().value as string);
        return cursor;
      },
      verify: (cursor, binding) => inner.verify(cursor, binding),
    },
    positionOf: (cursor) => positions.get(cursor),
  };
}

async function editionOf(server: RunningNeo4j): Promise<string> {
  const session = server.admin.session({ database: 'system' });
  try {
    const result = await session.run('CALL dbms.components() YIELD edition RETURN edition');
    return String(result.records[0]?.get('edition'));
  } finally {
    await session.close();
  }
}

/** Connects to the dev server, builds the three anchors and the gate that reads them with the run's reader login. A failure after the database was made drops it. */
export async function startRig(): Promise<Rig> {
  const server = await startNeo4j();
  try {
    const edition = await editionOf(server);
    await buildSupernodes(server);
    const defaults = communitySeams();
    const { codec, positionOf } = recordingCodec();
    const parts = createSourceGate({ cursors: codec, mapping: { sources: [sourceFor(server, { entities: ENTITIES, relationships: RELATIONSHIPS })] }, env: envFor(server), seams: { policy: defaults.policy, coordinator: defaults.coordinator, audit: defaults.audit }, logger: { warn: () => undefined }, usability: ALWAYS_USABLE });
    return { server, parts, edition, positionOf };
  } catch (error) {
    await server.stop().catch(() => undefined);
    throw error;
  }
}

export async function stopRig(rig: Rig | undefined): Promise<void> {
  await runAll([() => rig?.parts.close(), () => rig?.server.stop()]);
}
