import { communitySeams } from '../seams/community-seams.js';
import { assembleGate, type AssembleOptions } from '../gate/assemble.js';
import type { MappingModel } from '../mapping/model.js';
import { TestExecutor } from './gate.js';

export function testSourceGate(mapping: MappingModel, overrides: Partial<Omit<AssembleOptions, 'mapping' | 'executor'>> & { readonly executor?: TestExecutor } = {}) {
  const executor = overrides.executor ?? new TestExecutor();
  const logs: { fields: object; message: string }[] = [];
  const defaults = communitySeams();
  const parts = assembleGate({
    mapping,
    seams: overrides.seams ?? { policy: defaults.policy, coordinator: defaults.coordinator, audit: defaults.audit },
    executor,
    logger: overrides.logger ?? { warn: (fields, message) => void logs.push({ fields, message }) },
    clock: overrides.clock ?? (() => 1_000_000),
    ...(overrides.observer === undefined ? {} : { observer: overrides.observer }),
    ...(overrides.catalog === undefined ? {} : { catalog: overrides.catalog }),
    ...(overrides.redact === undefined ? {} : { redact: overrides.redact }),
  });
  return { ...parts, executor, logs };
}
