import { createGate } from '../gate/gate.js';
import type { Gate, GatePage, GateRequest } from '../gate/types.js';

export const route = createGate;
export type Shapes = Gate | GatePage | GateRequest;
