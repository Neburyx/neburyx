import { AppError } from '../errors.js';
import type { PolicyProvider } from '../seams/seams.js';
import type { GateContext } from './types.js';

export async function authorizeRequest(policy: PolicyProvider, context: GateContext): Promise<void> {
  const decision = await policy.authorizeSource({ principal: context.principal, sourceId: context.sourceId });
  if (!decision.allowed) throw new AppError('ACCESS_DENIED');
}
