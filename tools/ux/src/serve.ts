import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createSupportServer } from './support-server.ts';

const [folder, port, mode] = process.argv.slice(2);
if (folder === undefined || port === undefined) throw new Error('usage: serve.ts <built web folder> <port> [two-sources]');
const profile: { sourceId: string; entityTypes: { type: string }[]; presets?: unknown[] } = JSON.parse(readFileSync(new URL('../fixtures/profile.json', import.meta.url), 'utf8'));
const insurancePresets: unknown[] = JSON.parse(readFileSync(new URL('../fixtures/presets-insurance.json', import.meta.url), 'utf8'));
const [firstType] = profile.entityTypes;
const claimsTypes = firstType === undefined ? [] : ['claimant', 'address', 'claim'].map((type) => ({ ...firstType, type, label: type, displayName: type }));
const claimsProfile = { ...profile, sourceId: 'claims-demo', presets: insurancePresets, entityTypes: [...profile.entityTypes, ...claimsTypes] };
const twoSources = mode === 'two-sources';
const otherProfiles = twoSources ? [claimsProfile, { ...profile, sourceId: 'restricted-demo' }] : [];
createSupportServer({ root: resolve(folder), profile, otherProfiles, ...(twoSources ? { refusedSources: ['restricted-demo'] } : {}) }).listen(Number(port), '127.0.0.1');
