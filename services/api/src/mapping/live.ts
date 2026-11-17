import type { MappingModel } from './model.js';

/**
 * The mapping the running process holds, as one object whose parts are read from the current model every time: what captured it before a reload sees the model of the reload after it.
 * Only the dev reload replaces it.
 */
export interface LiveMapping extends MappingModel {
  /** The model the process holds now. */
  current(): MappingModel;
  replace(next: MappingModel): void;
}

export function createLiveMapping(initial: MappingModel): LiveMapping {
  let held = initial;
  return {
    get sources() {
      return held.sources;
    },
    get ai() {
      return held.ai;
    },
    get retention() {
      return held.retention;
    },
    current: () => held,
    replace(next) {
      held = next;
    },
  } as LiveMapping;
}
