import { describe, expect, it } from 'vitest';
import * as check from '../../../deploy/docker/check-platforms.mjs';

function archive(files: Readonly<Record<string, unknown>>): (path: string) => string {
  return (path) => {
    const content = files[path];
    if (content === undefined) throw new Error(`no ${path} in the archive`);
    return JSON.stringify(content);
  };
}

const INDEX = 'application/vnd.oci.image.index.v1+json';
const MANIFEST = 'application/vnd.oci.image.manifest.v1+json';

describe('platformsOf', () => {
  it('lists the platforms of the image index and ignores attestation manifests', () => {
    const read = archive({
      'index.json': { manifests: [{ mediaType: INDEX, digest: 'sha256:aa' }] },
      'blobs/sha256/aa': {
        manifests: [
          { mediaType: MANIFEST, digest: 'sha256:b1', platform: { os: 'linux', architecture: 'amd64' } },
          { mediaType: MANIFEST, digest: 'sha256:b2', platform: { os: 'linux', architecture: 'arm64' } },
          { mediaType: MANIFEST, digest: 'sha256:b3', platform: { os: 'unknown', architecture: 'unknown' } },
        ],
      },
    });
    expect(check.platformsOf(read)).toEqual(['linux/amd64', 'linux/arm64']);
    expect(check.missingPlatforms(check.platformsOf(read))).toEqual([]);
  });

  it('reports a platform that is missing', () => {
    const read = archive({
      'index.json': { manifests: [{ mediaType: MANIFEST, digest: 'sha256:b1', platform: { os: 'linux', architecture: 'amd64' } }] },
    });
    expect(check.platformsOf(read)).toEqual(['linux/amd64']);
    expect(check.missingPlatforms(check.platformsOf(read))).toEqual(['linux/arm64']);
  });

  it('finds nothing in an archive without manifests', () => {
    expect(check.platformsOf(archive({ 'index.json': {} }))).toEqual([]);
    expect(check.missingPlatforms([])).toEqual(['linux/amd64', 'linux/arm64']);
  });
});
