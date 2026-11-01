import { describe, expect, it } from 'vitest';
import { makeRoot } from './fixtures.js';
import { PackError, readIdentifiers } from './packs.js';

const FULL_PACK = `
sources:
  - id: marker_source_id
    uri: "bolt://marker-host:7687"
    database: marker_database
    auth: { kind: basic, username_env: MARKER_USER_VAR, password_env: MARKER_PASSWORD_VAR }
    vocabulary: { case_ref: "Marker case ref" }
    entities:
      - type: e_type
        label: e_label
        stable_id: e_stable
        title: "Marker title text {e_title_prop} and {e_title_other}"
        search: [e_search]
        pii: [e_pii]
        filterable: [e_filter]
        reference: [e_reference]
        link: "https://marker.example.test/{e_stable}"
        display: { icon: money, key_properties: [e_key_only], state_property: e_state }
    relationships:
      - type: r_type
        from: e_type
        to: e_type
        stable_id: r_stable
        observed_at: r_observed
        evidence: [r_evidence]
        filterable: [r_filter]
        evidence_link: "https://marker.example.test/{r_evidence}"
    derived:
      - id: marker_rule_id
        from: e_type
        to: e_type
        via: [r_type, e_type, r_type]
        rule_version: 1
        stop_list_property: d_stop
    patterns:
      - id: marker_preset_id
        name: "Marker preset name"
        template: shared-attribute
        bind: { anchor: e_type, attribute: e_type, via: r_type }
        labels: { anchor: "Marker label text" }
`;

const WRONG_SHAPE = 'sources:\n  - id: marker_value\n    entities: [{ type: 7, label: marker_label }]\n';

function rootWith(pack: string, name = 'sample'): string {
  return makeRoot({ [`domain-packs/${name}/neburyx.yaml`]: pack });
}

function failure(root: string): string {
  try {
    readIdentifiers(root);
  } catch (error) {
    if (error instanceof PackError) return error.message;
    throw error;
  }
  throw new Error('expected the read to fail');
}

describe('the identifiers of a pack', () => {
  const found = readIdentifiers(rootWith(FULL_PACK));
  const named = (kind: string) => found.filter((identifier) => identifier.kind === kind).map((identifier) => identifier.name).sort();

  it('are the entity types, labels, relationship types and every property key, each from its own place', () => {
    expect(named('entity type')).toEqual(['e_type']);
    expect(named('label')).toEqual(['e_label']);
    expect(named('relationship type')).toEqual(['r_type']);
    expect(named('property key')).toEqual(
      ['d_stop', 'e_filter', 'e_key_only', 'e_pii', 'e_reference', 'e_search', 'e_stable', 'e_state', 'e_title_other', 'e_title_prop', 'r_evidence', 'r_filter', 'r_observed', 'r_stable'].sort(),
    );
  });

  it('carry their pack and appear once per name, kind and pack', () => {
    expect(new Set(found.map((identifier) => identifier.pack))).toEqual(new Set(['sample']));
    expect(new Set(found.map((identifier) => `${identifier.name}|${identifier.kind}`)).size).toBe(found.length);
  });

  it('leave out the title text, preset and rule ids and names, the vocabulary, the source id, the address, the credential variables and the links', () => {
    const everything = JSON.stringify(found);
    for (const marker of ['Marker', 'marker_', 'MARKER_', 'marker-host', 'marker.example.test', 'marker_database']) expect(everything).not.toContain(marker);
  });

  it('are read from every pack in the folder', () => {
    const root = makeRoot({
      'domain-packs/one/neburyx.yaml': FULL_PACK,
      'domain-packs/two/neburyx.yaml': FULL_PACK.replace(/\be_/g, "f_").replace(/\br_/g, "s_").replace(/\bd_stop/g, "g_stop"),
      'domain-packs/README.md': 'not a pack',
    });
    expect(new Set(readIdentifiers(root).map((identifier) => identifier.pack))).toEqual(new Set(['one', 'two']));
  });
});

describe('a pack the check cannot read', () => {
  it('fails when the mapping file is missing, naming the file', () => {
    const root = makeRoot({ 'domain-packs/sample/README.md': 'no mapping here' });
    expect(failure(root)).toBe('domain-packs/sample/neburyx.yaml: the mapping file is missing');
  });

  it('fails when the file is not valid YAML, naming the file and the place and repeating no value', () => {
    const message = failure(rootWith('sources: [marker_value\n  - broken: marker_value'));
    expect(message).toMatch(/^domain-packs\/sample\/neburyx\.yaml: is not valid YAML \(\w+ at line \d+, column \d+\)$/);
    expect(message).not.toContain('marker_value');
  });

  it('fails when the file has another shape, naming the file and the place and repeating no value', () => {
    const message = failure(rootWith(WRONG_SHAPE));
    expect(message).toContain('domain-packs/sample/neburyx.yaml: does not have the shape the check reads');
    expect(message).toContain('sources.0.entities.0');
    expect(message).not.toContain('marker_value');
    expect(message).not.toContain('marker_label');
  });

  it('fails when a name is empty, because an empty name would leave the pack with nothing to guard', () => {
    const pack = 'sources:\n  - id: marker_value\n    entities: [{ type: "", label: "", stable_id: "" }]\n';
    expect(failure(rootWith(pack))).toContain('does not have the shape the check reads');
  });

  it('fails when an alias cannot be resolved, naming the file and repeating no value', () => {
    const message = failure(rootWith('sources: *MARKER_PRIVATE_VALUE\n'));
    expect(message).toBe('domain-packs/sample/neburyx.yaml: is not valid YAML data (an alias that cannot be resolved or expanded)');
  });

  it('fails when the mapping file cannot be read, naming the file', () => {
    const root = makeRoot({ 'domain-packs/sample/neburyx.yaml/inside.txt': 'a folder stands where the file belongs' });
    expect(failure(root)).toMatch(/^domain-packs\/sample\/neburyx\.yaml: cannot be read \(\w+\)$/);
  });

  it.each([
    ['an empty list of sources', 'sources: []\n'],
    ['sources without entities', 'sources:\n  - id: marker_value\n    entities: []\n'],
  ])('fails for %s, because a pack with nothing to guard would pass for nothing', (_name, pack) => {
    expect(failure(rootWith(pack))).toBe('domain-packs/sample/neburyx.yaml: has no identifiers to guard');
  });
});
