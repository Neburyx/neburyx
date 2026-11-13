import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BUDGET_DEFAULTS } from '../../../services/api/dist/mapping/budgets.js';
import { ASK_EVAL_DEFAULTS } from './defaults.js';

const API_SOURCE = resolve(import.meta.dirname, '..', '..', '..', 'services', 'api', 'src');
const read = (file: string): string => readFileSync(resolve(API_SOURCE, file), 'utf8');

describe('the defaults the scorer fills in', () => {
  it('has the default page of the budgets', () => {
    expect(ASK_EVAL_DEFAULTS.defaultPage).toBe(BUDGET_DEFAULTS.defaultPage);
  });

  it('has the minShared default of the shared-attribute template', () => {
    expect(read('gate/templates/shared-attribute.ts')).toContain(`.default(${ASK_EVAL_DEFAULTS.minShared})`);
  });

  it('has the maxHops default of the linked-entities template', () => {
    expect(read('gate/templates/linked-entities.ts')).toContain(`maxHops: hopsSchema.default(${ASK_EVAL_DEFAULTS.maxHops})`);
  });

  it('has the direction and sort the expand route fills in', () => {
    expect(read('app.ts')).toContain(`direction ?? '${ASK_EVAL_DEFAULTS.expandDirection}'`);
    expect(read('graph/expand-service.ts')).toContain(`sort: '${ASK_EVAL_DEFAULTS.expandSort}'`);
  });
});
