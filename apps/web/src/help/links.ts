export const REPOSITORY_URL = 'https://github.com/Neburyx/neburyx';

export const QUICKSTART_ANCHOR = 'quickstart';

/** A `mailto:` address opens the person's mail program; every other target opens in a new tab with no opener and no referrer. */
export const opensInNewTab = (address: string): boolean => !address.startsWith('mailto:');

export const HELP_LINKS = {
  documentation: `${REPOSITORY_URL}/tree/main/docs`,
  quickstart: `${REPOSITORY_URL}#${QUICKSTART_ANCHOR}`,
  enterprise: `${REPOSITORY_URL}/discussions`,
  problem: `${REPOSITORY_URL}/issues`,
  installGuide: `${REPOSITORY_URL}/blob/main/docs/install.md`,
} as const;

/** The mapping guide at its style rules section, which the legend's "Edit rules in neburyx.yaml" link opens. */
export const STYLE_RULES_GUIDE = `${REPOSITORY_URL}/blob/main/docs/mapping-guide.md#style-rules`;
