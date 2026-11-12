import { describe, expect, it } from 'vitest';
import { planImages, TEST_IMAGE_VARIABLE, TEST_LOADER_VARIABLE } from './image-plan.js';

const OWN = { image: 'own-image', tag: 'a-1' };
const OWN_WITH_LOADER = { ...OWN, loader: 'own-loader:a-1' };

describe('choosing the images of a compose test file', () => {
  it('builds its own images when the environment names none, so a local run needs no setup', () => {
    expect(planImages({}, OWN)).toEqual({ image: 'own-image', tag: 'a-1', loader: '', built: true });
    expect(planImages({}, OWN_WITH_LOADER)).toEqual({ image: 'own-image', tag: 'a-1', loader: 'own-loader:a-1', built: true });
  });

  it('uses the named images and builds none, and splits the name from the tag at the last colon', () => {
    const env = { [TEST_IMAGE_VARIABLE]: 'registry.example:5000/team/neburyx:run-7', [TEST_LOADER_VARIABLE]: 'loader:run-7' };
    expect(planImages(env, OWN_WITH_LOADER)).toEqual({ image: 'registry.example:5000/team/neburyx', tag: 'run-7', loader: 'loader:run-7', built: false });
  });

  it('needs no loader image for a file that has no loader, and ignores a loader variable it does not need', () => {
    expect(planImages({ [TEST_IMAGE_VARIABLE]: 'shared:run-7' }, OWN)).toEqual({ image: 'shared', tag: 'run-7', loader: '', built: false });
    expect(planImages({ [TEST_LOADER_VARIABLE]: 'loader:run-7' }, OWN)).toMatchObject({ built: true });
  });

  it('fails at once, naming the missing variable, when a file that needs both gets one', () => {
    expect(() => planImages({ [TEST_IMAGE_VARIABLE]: 'shared:run-7' }, OWN_WITH_LOADER)).toThrow(TEST_LOADER_VARIABLE);
    expect(() => planImages({ [TEST_LOADER_VARIABLE]: 'loader:run-7' }, OWN_WITH_LOADER)).toThrow(TEST_IMAGE_VARIABLE);
  });

  it('treats an empty variable as not set', () => {
    expect(planImages({ [TEST_IMAGE_VARIABLE]: '', [TEST_LOADER_VARIABLE]: '' }, OWN_WITH_LOADER)).toMatchObject({ built: true });
  });

  it.each(['shared', 'shared:', ':run-7', 'host:5000/shared'])('refuses %j as an image name and tag', (value) => {
    expect(() => planImages({ [TEST_IMAGE_VARIABLE]: value, [TEST_LOADER_VARIABLE]: 'loader:1' }, OWN_WITH_LOADER)).toThrow(TEST_IMAGE_VARIABLE);
  });
});
