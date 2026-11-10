import { test } from '@playwright/test';
import { ENVIRONMENTS, TRUST_CASES } from './support/trust-cases.ts';

/**
 * The scripted cases of "can I trust this relationship?" (`support/trust-cases.ts`), run at both window sizes by the projects of the configuration, in each environment that holds the kind of
 * relationship. a later end-to-end test imports the same list over a real demo graph.
 */
for (const environment of ENVIRONMENTS) {
  test.describe(`trust a relationship: ${environment.name}`, () => {
    for (const scripted of TRUST_CASES) {
      test(`${scripted.id}: ${scripted.title}`, async ({ page }) => {
        await scripted.run(page, environment);
      });
    }
  });
}
