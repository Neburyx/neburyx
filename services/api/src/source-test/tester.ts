import type { SourceTestReport } from '@neburyx/contracts';
import { AppError } from '../errors.js';
import type { Clock, Gate, GateLogger } from '../gate/types.js';
import type { MappingModel } from '../mapping/model.js';
import type { Principal } from '../seams/seams.js';
import { checkSource, type CheckRequest, type CheckStore } from './check.js';
import type { WriteProbe } from './probe.js';

export interface SourceTestRequest {
  readonly traceId: string;
  readonly principal: Principal;
  readonly sourceId: string;
}

/** Runs the capabilities check for a configured source as the principal it is given. */
export interface SourceTester {
  run(request: SourceTestRequest): Promise<SourceTestReport>;
}

export interface SourceTesterDeps {
  readonly gate: Gate;
  readonly mapping: MappingModel;
  readonly store: CheckStore;
  readonly clock?: Clock;
  /** Given by the `test-source` command when it runs the opt-in write probe; the route builds its tester without one. */
  readonly probe?: WriteProbe;
  readonly logger?: GateLogger;
}

export function createSourceTester(deps: SourceTesterDeps): SourceTester {
  const clock = deps.clock ?? Date.now;
  return {
    async run(request) {
      const source = deps.mapping.sources.find((candidate) => candidate.id === request.sourceId);
      if (source === undefined) throw new AppError('NOT_FOUND');
      const run = (gateRequest: CheckRequest) => deps.gate.run({ ...gateRequest, principal: request.principal });
      return checkSource({ store: deps.store, clock, ...(deps.probe === undefined ? {} : { probe: deps.probe }), ...(deps.logger === undefined ? {} : { logger: deps.logger }) }, source, run, request.traceId, request.principal.id);
    },
  };
}
