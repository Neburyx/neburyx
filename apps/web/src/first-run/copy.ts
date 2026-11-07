export const FIRST_RUN_COPY = {
  title: 'Investigations',
  tag: 'No sign-in',
  subtitleWithDemo: 'No source of your own connected',
  subtitleNone: 'No source connected',
  emptyTitle: 'No investigations yet',
  sentenceWithDemo: 'Open the synthetic demo graph, or connect your own read-only Neo4j.',
  sentenceWithoutDemo: 'Connect your own read-only Neo4j.',
  sentenceHomeWithDemo: 'Open the demo case, search for an entity or open a deep link.',
  sentenceHomeWithoutDemo: 'Search for an entity or open a deep link.',
  openDemoCase: 'Open demo case',
  connect: 'Connect your Neo4j',
  loading: 'Loading…',
} as const;

export const SETUP_COPY = {
  label: 'Source setup',
  command: 'neburyx test-source --name <source>',
  line: 'Connect through your YAML configuration, then test the read-only source.',
  copy: 'Copy',
  copied: 'Copied',
  couldNotCopy: 'Could not copy',
} as const;

export const STEPS_COPY = {
  label: 'Getting started',
  steps: [
    { title: 'Map your schema in YAML', text: 'Describe the labels and indexed properties you investigate.' },
    { title: 'Search or open a deep link', text: 'Start with a configured ID or jump straight to an entity.' },
    { title: 'Expand safely and verify relationships', text: 'Follow relationships and inspect the evidence. Your source stays unchanged.' },
  ],
} as const;
