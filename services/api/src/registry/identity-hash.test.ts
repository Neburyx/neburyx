import { describe, expect, it } from 'vitest';
import { identityHashOf } from './identity-hash.js';

const connection = { uri: 'neo4j+s://graph.example.test:7687', database: 'neo4j' };

describe('the source identity hash', () => {
  it('gives a fixed digest for a fixed connection, so it cannot change silently', () => {
    expect(identityHashOf(connection)).toBe('5b082d4c1e423c43dbe6c5c394d77c653b73201e7499f2dc29a4cb8a6b8e375c');
  });

  it('differs when the address or the database differs', () => {
    expect(identityHashOf({ ...connection, uri: 'neo4j+s://other.example.test:7687' })).not.toBe(identityHashOf(connection));
    expect(identityHashOf({ ...connection, database: 'other' })).not.toBe(identityHashOf(connection));
  });

  it('is the same for the same connection however the source is named or authenticated', () => {
    expect(identityHashOf({ ...connection })).toBe(identityHashOf(connection));
  });

  it('is a SHA-256 hex digest', () => {
    expect(identityHashOf(connection)).toMatch(/^[0-9a-f]{64}$/);
  });
});
