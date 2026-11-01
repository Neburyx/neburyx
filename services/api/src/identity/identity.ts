import type { MeResponse } from '@neburyx/contracts';

export type Identity = Omit<MeResponse, 'sources'>;
