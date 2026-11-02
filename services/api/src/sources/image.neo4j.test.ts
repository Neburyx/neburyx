import { describe, expect, it } from 'vitest';
import { startNeo4j } from '../testing/neo4j-container.js';

describe('a Neo4j image that cannot be started', () => {
  it('fails with a message that names the image, and does not skip', async () => {
    await expect(startNeo4j('neo4j:this-tag-does-not-exist-0')).rejects.toThrow('could not start the Neo4j image neo4j:this-tag-does-not-exist-0');
  });
});
