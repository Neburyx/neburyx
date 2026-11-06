import { createSourceAccess } from '../investigations/source-access.js';
import type { MappingModel } from '../mapping/model.js';
import { communitySeams } from '../seams/community-seams.js';

export function communityAccess(mapping: MappingModel) {
  const { policy, audit } = communitySeams();
  return createSourceAccess({ mapping, seams: { policy, audit }, logger: { warn: () => undefined } });
}
