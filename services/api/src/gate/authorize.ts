import { AppError } from '../errors.js';
import type { PolicyProvider } from '../seams/seams.js';
import { isSystemId } from './system-principal.js';
import type { GateContext, Template } from './types.js';

export async function authorizeRequest(policy: PolicyProvider, context: GateContext, template: Template): Promise<void> {
  if (context.system) {
    if (template.scope !== 'system') throw new AppError('ACCESS_DENIED');
    return;
  }
  if (isSystemId(context.principal.id)) throw new AppError('ACCESS_DENIED');
  const decision = await policy.authorizeSource({ principal: context.principal, sourceId: context.sourceId });
  if (!decision.allowed) throw new AppError('ACCESS_DENIED');
}
