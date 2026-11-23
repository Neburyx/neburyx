/**
 * The allowlist of the tools the Assistant may offer a model, written out by name and in one place. It is data on purpose: a tool added to the registry, or by a framework upgrade, is not on it until a person
 * puts it here, which is what the guard test is for. The intents are those of the fixture folder of the test rig; the pattern key is the one the rig's saved pattern gets.
 */
const TEMPLATE_TOOL_NAMES = ['entity', 'degree-preview', 'expand', 'shared-attribute', 'linked-entities', 'derived-rule-run', 'derived-edge-support', 'search', 'shortest-paths'] as const;
const FIXTURE_INTENT_NAMES = ['byId', 'shared'] as const;
const FIXTURE_PATTERN_KEYS = ['pat_1'] as const;
const FIXED_TOOL_NAMES = ['view', 'ai-notes', 'ai-summary', 'typology', 'answer'] as const;

export const ALLOWED_TOOL_NAMES: readonly string[] = [...TEMPLATE_TOOL_NAMES, ...FIXTURE_INTENT_NAMES, ...FIXTURE_PATTERN_KEYS, ...FIXED_TOOL_NAMES];

/** Tools deepagents 1.17.0 always assembles and its exclusion removes before a model sees them. Nothing else outside the allowlist may be assembled. */
export const KNOWN_REMOVED_FRAMEWORK_TOOLS = ['read_file', 'task'] as const;
