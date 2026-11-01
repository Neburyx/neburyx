import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const REQUIRED_PLATFORMS = ['linux/amd64', 'linux/arm64'];

export function platformsOf(readFile) {
  const found = new Set();
  const visit = (descriptor) => {
    if (descriptor.platform) {
      const { os, architecture } = descriptor.platform;
      if (os !== 'unknown') found.add(`${os}/${architecture}`);
      return;
    }
    if (typeof descriptor.mediaType === 'string' && descriptor.mediaType.includes('index')) {
      const index = JSON.parse(readFile(`blobs/${descriptor.digest.replace(':', '/')}`));
      for (const child of index.manifests ?? []) visit(child);
    }
  };
  for (const descriptor of JSON.parse(readFile('index.json')).manifests ?? []) visit(descriptor);
  return [...found].sort();
}

export function missingPlatforms(platforms) {
  return REQUIRED_PLATFORMS.filter((platform) => !platforms.includes(platform));
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const archive = process.argv[2];
  if (archive === undefined) {
    process.stderr.write('usage: node check-platforms.mjs <oci-archive.tar>\n');
    process.exit(2);
  }
  const platforms = platformsOf((path) => execFileSync('tar', ['-xOf', archive, path], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
  const missing = missingPlatforms(platforms);
  process.stdout.write(`platforms: ${platforms.join(', ') || 'none'}\n`);
  if (missing.length > 0) {
    process.stderr.write(`missing: ${missing.join(', ')}\n`);
    process.exit(1);
  }
}
