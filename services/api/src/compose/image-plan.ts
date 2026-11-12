export const TEST_IMAGE_VARIABLE = 'NEBURYX_TEST_IMAGE';
export const TEST_LOADER_VARIABLE = 'NEBURYX_TEST_LOADER_IMAGE';

export interface ImagePlan {
  readonly image: string;
  readonly tag: string;
  /** The demo loader image; empty for a file that has no loader. */
  readonly loader: string;
  /** True when the file builds its own images, false when it uses the ones the environment names. */
  readonly built: boolean;
}

export interface OwnImages {
  readonly image: string;
  readonly tag: string;
  readonly loader?: string;
}

function splitImage(reference: string): { readonly image: string; readonly tag: string } {
  const colon = reference.lastIndexOf(':');
  if (colon <= 0 || colon === reference.length - 1 || reference.slice(colon).includes('/')) throw new Error(`${TEST_IMAGE_VARIABLE} must be an image name and a tag, like name:tag`);
  return { image: reference.slice(0, colon), tag: reference.slice(colon + 1) };
}

const present = (value: string | undefined): string | undefined => (value === undefined || value === '' ? undefined : value);

/**
 * Which images a compose test file uses: the ones the environment names (built once by the CI run) or, with none named, its own, which it builds.
 * A file that needs a loader image as well fails at once when only one of the two variables is set.
 */
export function planImages(env: Readonly<Record<string, string | undefined>>, own: OwnImages): ImagePlan {
  const named = present(env[TEST_IMAGE_VARIABLE]);
  const loader = present(env[TEST_LOADER_VARIABLE]);
  const needsLoader = own.loader !== undefined;
  if (named === undefined) {
    if (needsLoader && loader !== undefined) throw new Error(`${TEST_LOADER_VARIABLE} is set but ${TEST_IMAGE_VARIABLE} is not; set both or neither`);
    return { image: own.image, tag: own.tag, loader: own.loader ?? '', built: true };
  }
  if (needsLoader && loader === undefined) throw new Error(`${TEST_IMAGE_VARIABLE} is set but ${TEST_LOADER_VARIABLE} is not; set both or neither`);
  return { ...splitImage(named), loader: needsLoader ? (loader ?? '') : '', built: false };
}
