/** Replaced with the address of the public repository when it is published. */
export const REPOSITORY_URL = 'NEBURYX_RELEASE_PLACEHOLDER_REPOSITORY_URL';

export const QUICKSTART_ANCHOR = 'quickstart';

export const HELP_LINKS = {
  documentation: `${REPOSITORY_URL}/tree/main/docs`,
  quickstart: `${REPOSITORY_URL}#${QUICKSTART_ANCHOR}`,
  enterprise: `${REPOSITORY_URL}/discussions`,
  problem: `${REPOSITORY_URL}/issues`,
  installGuide: `${REPOSITORY_URL}/blob/main/docs/install.md`,
} as const;
