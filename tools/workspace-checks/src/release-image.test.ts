import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import * as release from '../../../deploy/release/release-image.mjs';
import { repoRoot } from './workspace.js';

interface Call {
  readonly tool: string;
  readonly args: readonly string[];
}
interface Script {
  readonly scanStatus?: number;
  readonly git?: Readonly<Record<string, { status: number; stdout?: string }>>;
  readonly failTool?: string;
  readonly digestFileContent?: string;
  readonly indexJson?: string;
}

const DIGEST = `sha256:${'a'.repeat(64)}`;
const TOKEN = release.TOKEN_PREFIX;
const FILLED = JSON.stringify({ registry: 'registry.example', image: 'team/neburyx' });
const PLACEHOLDER_TARGET = JSON.stringify({ registry: `${TOKEN}REGISTRY`, image: `${TOKEN}IMAGE` });
const INDEX = JSON.stringify({ manifests: [{ digest: DIGEST }] });

interface Answer {
  readonly status: number;
  readonly body: unknown;
}

function harness(options: { target?: string; script?: Script; env?: Record<string, string | undefined>; answer?: Answer | Error } = {}) {
  const requests: { url: string; token: string | undefined }[] = [];
  const calls: Call[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const removed: string[] = [];
  const script = options.script ?? {};
  const files = new Map<string, string>([[release.TARGET_FILE, options.target ?? FILLED]]);
  const deps: release.Deps = {
    exec: (tool, args) => {
      calls.push({ tool, args });
      if (tool === script.failTool) return { status: 1, stdout: '' };
      if (tool === 'git') return { stdout: '', ...(script.git?.[args.join(' ')] ?? { status: 0, stdout: 'abc\n' }) };
      if (tool === 'tar') return { status: 0, stdout: args[0] === '-xOf' ? (script.indexJson ?? INDEX) : '' };
      if (tool === 'sh') return { status: script.scanStatus ?? 0, stdout: '' };
      if (tool === 'skopeo') {
        const digestFile = args[args.indexOf('--digestfile') + 1] ?? '';
        if (script.digestFileContent !== undefined) files.set(digestFile, script.digestFileContent);
        else files.set(digestFile, DIGEST);
      }
      return { status: 0, stdout: '' };
    },
    readFile: (path) => {
      const content = files.get(path);
      if (content === undefined) throw new Error(`no ${path}`);
      return content;
    },
    listDir: () => ['blob-a', 'blob-b'],
    makeTempDir: () => '/work',
    removeDir: (path) => removed.push(path),
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    env: options.env ?? {},
    fetchRuns: (url, token) => {
      requests.push({ url, token });
      const answer = options.answer ?? { status: 200, body: { workflow_runs: [] } };
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
    },
  };
  return { deps, calls, out, err, removed, requests };
}

const TAGGED_HEAD = { 'rev-parse v0.1.0^{commit}': { status: 0, stdout: 'abc\n' } };

describe('the tag rule', () => {
  it.each(['v0.1', '0.1.0', 'v0.1.0-rc1', 'v1.2.3.4', '', 'latest'])('refuses %j in every mode, before any command runs', (tag) => {
    for (const mode of ['--dry-run', '--push', '--check-target', '--check-ci']) {
      const { deps, calls, err } = harness();
      expect(release.run(['--tag', tag, mode], deps)).toBe(2);
      expect(calls).toEqual([]);
      expect(err.join('')).toContain('v<major>.<minor>.<patch>');
    }
  });

  it('accepts a three-part tag and gives the image the version without the v', () => {
    expect(release.tagProblem('v0.1.0')).toBeUndefined();
    expect(release.versionOf('v0.1.0')).toBe('0.1.0');
  });
});

describe('the options', () => {
  it.each([
    [['--dry-run']],
    [['--tag']],
    [['--tag', 'v0.1.0', '--bogus']],
    [['--tag', 'v0.1.0', '--dry-run', '--push']],
    [['--tag', 'v0.1.0', '--push', '--check-target']],
  ])('prints the usage and exits 2 for %j', (argv) => {
    const { deps, calls, err } = harness();
    expect(release.run(argv, deps)).toBe(2);
    expect(calls).toEqual([]);
    expect(err.join('')).toContain('usage:');
  });

  it('runs a dry run when no mode is given', () => {
    const { deps, out } = harness();
    expect(release.run(['--tag', 'v0.1.0'], deps)).toBe(0);
    expect(out.join('')).toContain('dry run: nothing was published');
  });
});

describe('the dry run', () => {
  it('runs exactly the multi-platform build to an OCI archive and the platform check', () => {
    const { deps, calls, out, removed } = harness({ target: PLACEHOLDER_TARGET });
    expect(release.run(['--tag', 'v0.1.0', '--dry-run'], deps)).toBe(0);
    expect(calls).toEqual([
      {
        tool: 'docker',
        args: [
          'buildx',
          'build',
          '--platform',
          'linux/amd64,linux/arm64',
          '-f',
          'deploy/docker/Dockerfile',
          '--output',
          'type=oci,dest=/work/neburyx.oci.tar',
          '.',
        ],
      },
      { tool: 'node', args: ['deploy/docker/check-platforms.mjs', '/work/neburyx.oci.tar'] },
      { tool: 'mkdir', args: ['-p', '/work/archive'] },
      { tool: 'tar', args: ['-xf', '/work/neburyx.oci.tar', '-C', '/work/archive'] },
      ...['blob-a', 'blob-b'].map((blob) => ({
        tool: 'sh',
        args: ['-c', expect.stringContaining('grep -aqE'), 'scan', `/work/archive/blobs/sha256/${blob}`, `${TOKEN}[A-Z0-9]`],
      })),
    ]);
    expect(out.join('')).toBe('dry run: nothing was published\n');
    expect(removed).toEqual(['/work']);
  });

  it('writes nothing to a registry: no push, login or skopeo in any command', () => {
    const { deps, calls } = harness();
    release.run(['--tag', 'v0.1.0'], deps);
    const text = JSON.stringify(calls);
    for (const forbidden of ['--push', 'login', 'skopeo', 'crane', '"push"']) expect(text).not.toContain(forbidden);
  });

  it('fails when the build fails, and does not run the platform check', () => {
    const { deps, calls, err } = harness({ script: { failTool: 'docker' } });
    expect(release.run(['--tag', 'v0.1.0'], deps)).toBe(1);
    expect(calls.map((call) => call.tool)).toEqual(['docker']);
    expect(err.join('')).toContain('build failed');
  });

  it('fails when the platform check fails', () => {
    const { deps, err } = harness({ script: { failTool: 'node' } });
    expect(release.run(['--tag', 'v0.1.0'], deps)).toBe(1);
    expect(err.join('')).toContain('platform check failed');
  });
});

describe('the left-over placeholder scan of the built image', () => {
  it('fails a dry run when a layer holds a token, naming no content', () => {
    const { deps, err, out } = harness({ script: { scanStatus: 1 } });
    expect(release.run(['--tag', 'v0.1.0', '--dry-run'], deps)).toBe(1);
    expect(err.join('')).toContain('placeholder that was not replaced');
    expect(out.join('')).toBe('');
  });

  it('fails a push, and pushes nothing, when a layer holds a token', () => {
    const { deps, calls } = harness({ script: { git: TAGGED_HEAD, scanStatus: 1 } });
    expect(release.run(['--tag', 'v0.1.0', '--push'], deps)).toBe(1);
    expect(calls.map((call) => call.tool)).not.toContain('skopeo');
  });

  it('fails when a layer cannot be searched (compressed in a form the scan cannot read)', () => {
    const { deps, err } = harness({ script: { scanStatus: 3 } });
    expect(release.run(['--tag', 'v0.1.0'], deps)).toBe(1);
    expect(err.join('')).toContain('cannot be searched');
  });

  it('fails when the archive cannot be unpacked', () => {
    const { deps, err } = harness({ script: { failTool: 'tar' } });
    expect(release.run(['--tag', 'v0.1.0'], deps)).toBe(1);
    expect(err.join('')).toContain('could not be unpacked');
  });

  it('finds a token in a real file and ignores a clean one, and reads a gzip layer', () => {
    const dir = mkdtempSync(join(tmpdir(), 'release-scan-'));
    try {
      const pattern = `${TOKEN}[A-Z0-9]`;
      const shell = (file: string) => spawnSync('sh', ['-c', release.SCAN_BLOB, 'scan', file, pattern]).status;
      writeFileSync(join(dir, 'clean'), 'nothing here');
      writeFileSync(join(dir, 'dirty'), `a ${TOKEN}REPOSITORY_URL b`);
      writeFileSync(join(dir, 'prefix-alone'), `x ${TOKEN}`);
      writeFileSync(join(dir, 'dirty.txt'), `a ${TOKEN}IMAGE b`);
      spawnSync('gzip', ['-k', join(dir, 'dirty.txt')]);
      writeFileSync(join(dir, 'zstd'), Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 1, 2, 3]));
      expect(shell(join(dir, 'clean'))).toBe(0);
      expect(shell(join(dir, 'prefix-alone'))).toBe(0);
      expect(shell(join(dir, 'dirty'))).toBe(1);
      expect(shell(join(dir, 'dirty.txt.gz'))).toBe(1);
      expect(shell(join(dir, 'zstd'))).toBe(3);
      const whole = readFileSync(join(dir, 'dirty.txt.gz'));
      writeFileSync(join(dir, 'truncated.gz'), whole.subarray(0, whole.length - 6));
      writeFileSync(join(dir, 'corrupt.gz'), Buffer.concat([whole.subarray(0, 12), Buffer.from('xxxxxxxx'), whole.subarray(20)]));
      expect(shell(join(dir, 'truncated.gz'))).toBe(3);
      expect(shell(join(dir, 'corrupt.gz'))).toBe(3);
      writeFileSync(join(dir, 'unreadable'), 'a');
      chmodSync(join(dir, 'unreadable'), 0o000);
      expect(shell(join(dir, 'unreadable'))).toBe(3);
      expect(shell(join(dir, 'missing'))).toBe(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the target check', () => {
  it('prints the registry host and exits 0 for a filled target, running no command', () => {
    const { deps, calls, out } = harness();
    expect(release.run(['--tag', 'v0.1.0', '--check-target'], deps)).toBe(0);
    expect(out.join('')).toBe('registry: registry.example\n');
    expect(calls).toEqual([]);
  });

  it.each([
    ['registry', JSON.stringify({ registry: `${TOKEN}REGISTRY`, image: 'team/neburyx' })],
    ['image', JSON.stringify({ registry: 'registry.example', image: `${TOKEN}IMAGE` })],
    ['registry', JSON.stringify({ image: 'team/neburyx' })],
    ['image', JSON.stringify({ registry: 'registry.example', image: '  ' })],
  ])('exits 1 naming the file and `%s` when it is a placeholder or missing', (field, target) => {
    const { deps, calls, err } = harness({ target });
    expect(release.run(['--tag', 'v0.1.0', '--check-target'], deps)).toBe(1);
    expect(err.join('')).toContain(release.TARGET_FILE);
    expect(err.join('')).toContain(`\`${field}\``);
    expect(calls).toEqual([]);
  });

  it('exits 1 when the file is not JSON', () => {
    const { deps, err } = harness({ target: 'not json' });
    expect(release.run(['--tag', 'v0.1.0', '--check-target'], deps)).toBe(1);
    expect(err.join('')).toContain(release.TARGET_FILE);
  });
});

describe('the push', () => {
  it('refuses a placeholder before any command runs', () => {
    const { deps, calls, err } = harness({ target: PLACEHOLDER_TARGET });
    expect(release.run(['--tag', 'v0.1.0', '--push'], deps)).toBe(1);
    expect(calls).toEqual([]);
    expect(err.join('')).toContain(release.TARGET_FILE);
  });

  it('refuses a HEAD that is not on origin/main and builds nothing', () => {
    const { deps, calls, err } = harness({ script: { git: { 'merge-base --is-ancestor HEAD origin/main': { status: 1 } } } });
    expect(release.run(['--tag', 'v0.1.0', '--push'], deps)).toBe(1);
    expect(calls.map((call) => call.tool)).not.toContain('docker');
    expect(err.join('')).toContain('not on origin/main');
  });

  it('refuses a tag that points elsewhere and builds nothing', () => {
    const { deps, calls, err } = harness({ script: { git: { 'rev-parse v0.1.0^{commit}': { status: 0, stdout: 'other\n' } } } });
    expect(release.run(['--tag', 'v0.1.0', '--push'], deps)).toBe(1);
    expect(calls.map((call) => call.tool)).not.toContain('docker');
    expect(err.join('')).toContain('does not point at HEAD');
  });

  it('refuses a tag that does not exist', () => {
    const { deps, err } = harness({ script: { git: { 'rev-parse v0.1.0^{commit}': { status: 128 } } } });
    expect(release.run(['--tag', 'v0.1.0', '--push'], deps)).toBe(1);
    expect(err.join('')).toContain('does not point at HEAD');
  });

  it('pushes nothing when the platform check fails', () => {
    const { deps, calls } = harness({ script: { git: TAGGED_HEAD, failTool: 'node' } });
    expect(release.run(['--tag', 'v0.1.0', '--push'], deps)).toBe(1);
    expect(calls.map((call) => call.tool)).not.toContain('skopeo');
  });

  it('copies the checked archive with skopeo to one reference named by the version and prints the digest', () => {
    const { deps, calls, out, removed } = harness({ script: { git: TAGGED_HEAD } });
    expect(release.run(['--tag', 'v0.1.0', '--push'], deps)).toBe(0);
    const writers = calls.filter((call) => ['skopeo', 'crane'].includes(call.tool) || call.args.includes('push') || call.args.includes('--push'));
    expect(writers).toEqual([
      {
        tool: 'skopeo',
        args: [
          'copy',
          '--all',
          '--digestfile',
          '/work/digest.txt',
          'oci-archive:/work/neburyx.oci.tar',
          'docker://registry.example/team/neburyx:0.1.0',
        ],
      },
    ]);
    expect(out.join('')).toContain(`digest: ${DIGEST}`);
    expect(out.join('')).not.toContain('latest');
    expect(removed).toEqual(['/work']);
  });

  it('exits 1 when the pushed digest differs from the checked archive', () => {
    const other = `sha256:${'b'.repeat(64)}`;
    const { deps, err, out } = harness({ script: { git: TAGGED_HEAD, digestFileContent: other } });
    expect(release.run(['--tag', 'v0.1.0', '--push'], deps)).toBe(1);
    expect(err.join('')).toContain('differs from the checked archive');
    expect(out.join('')).not.toContain('digest:');
  });

  it.each(['', 'not-a-digest', 'sha256:abc'])('exits 1 when skopeo wrote %j as the digest', (content) => {
    const { deps, err } = harness({ script: { git: TAGGED_HEAD, digestFileContent: content } });
    expect(release.run(['--tag', 'v0.1.0', '--push'], deps)).toBe(1);
    expect(err.join('')).toContain('no digest');
  });

  it('exits 1 when the archive holds more than one image index', () => {
    const indexJson = JSON.stringify({ manifests: [{ digest: DIGEST }, { digest: DIGEST }] });
    const { deps, err } = harness({ script: { git: TAGGED_HEAD, indexJson } });
    expect(release.run(['--tag', 'v0.1.0', '--push'], deps)).toBe(1);
    expect(err.join('')).toContain('differs from the checked archive');
  });

  it('exits 1 when skopeo fails', () => {
    const { deps, err } = harness({ script: { git: TAGGED_HEAD, failTool: 'skopeo' } });
    expect(release.run(['--tag', 'v0.1.0', '--push'], deps)).toBe(1);
    expect(err.join('')).toContain('push failed');
  });
});

describe('the main and tag guards on a throw-away repository', () => {
  function git(cwd: string, ...args: string[]) {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    return { status: result.status ?? 1, stdout: result.stdout };
  }

  function repositoryWith(tagOnHead: boolean) {
    const root = mkdtempSync(join(tmpdir(), 'release-guard-'));
    const origin = join(root, 'origin.git');
    const work = join(root, 'work');
    mkdirSync(work);
    git(root, 'init', '--bare', '-b', 'main', origin);
    git(work, 'init', '-b', 'main');
    git(work, 'config', 'user.name', 'Test');
    git(work, 'config', 'user.email', 'test@example.invalid');
    writeFileSync(join(work, 'a.txt'), 'a');
    git(work, 'add', '.');
    git(work, 'commit', '-m', 'first');
    git(work, 'remote', 'add', 'origin', origin);
    git(work, 'push', 'origin', 'main');
    if (tagOnHead) git(work, 'tag', 'v0.1.0');
    return { root, work };
  }

  function realGit(work: string) {
    const { deps, out, err } = harness();
    return {
      deps: { ...deps, exec: (tool: string, args: readonly string[]) => (tool === 'git' ? git(work, ...args) : { status: 0, stdout: '' }) },
      out,
      err,
    };
  }

  it('passes the guards for a tagged HEAD that is on origin/main and stops at the missing digest', () => {
    const { root, work } = repositoryWith(true);
    try {
      const { deps, err } = realGit(work);
      expect(release.run(['--tag', 'v0.1.0', '--push'], deps)).toBe(1);
      expect(err.join('')).toContain('no digest');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses a HEAD that origin/main does not contain', () => {
    const { root, work } = repositoryWith(true);
    try {
      writeFileSync(join(work, 'b.txt'), 'b');
      git(work, 'add', '.');
      git(work, 'commit', '-m', 'second');
      git(work, 'tag', '-f', 'v0.1.0');
      const { deps, err } = realGit(work);
      expect(release.run(['--tag', 'v0.1.0', '--push'], deps)).toBe(1);
      expect(err.join('')).toContain('not on origin/main');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses a missing tag', () => {
    const { root, work } = repositoryWith(false);
    try {
      const { deps, err } = realGit(work);
      expect(release.run(['--tag', 'v0.1.0', '--push'], deps)).toBe(1);
      expect(err.join('')).toContain('does not point at HEAD');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('the CI check', () => {
  const SHA = 'abc';
  const REPOSITORY = 'owner/repo';
  const env = { GITHUB_REPOSITORY: REPOSITORY, GITHUB_TOKEN: 'MARKER_TOKEN' };
  const git = { 'rev-parse v0.1.0^{commit}': { status: 0, stdout: `${SHA}\n` } };
  const found = (over: Record<string, unknown> = {}) => ({ id: 7, head_sha: SHA, head_branch: 'main', event: 'push', status: 'completed', conclusion: 'success', head_repository: { full_name: REPOSITORY }, ...over });
  const check = (runs: unknown, extra: { answer?: Answer | Error; env?: Record<string, string | undefined> } = {}) => {
    const made = harness({ script: { git }, env, answer: { status: 200, body: { workflow_runs: runs } }, ...extra });
    return { made, result: release.checkCi(['--tag', 'v0.1.0', '--check-ci'], made.deps) };
  };

  it('exits 0 and names the run when the commit has a completed successful push run on main from this repository', async () => {
    const { made, result } = check([found()]);
    expect(await result).toBe(0);
    expect(made.out.join('')).toBe(`ci: run 7 succeeded for ${SHA}\n`);
  });

  it('asks for the runs of ci.yml of this commit, on main, from a push, with the token, and writes nothing', async () => {
    const { made, result } = check([found()]);
    await result;
    expect(made.requests).toEqual([{ url: `https://api.github.com/repos/${REPOSITORY}/actions/workflows/ci.yml/runs?head_sha=${SHA}&branch=main&event=push&per_page=100`, token: 'MARKER_TOKEN' }]);
    expect(made.calls.map((call) => call.tool)).toEqual(['git']);
  });

  it.each([
    ['a failed run', [found({ conclusion: 'failure' })], 'completed/failure'],
    ['a cancelled run', [found({ conclusion: 'cancelled' })], 'completed/cancelled'],
    ['a run still in progress', [found({ status: 'in_progress', conclusion: null })], 'in_progress/none'],
  ])('exits 1 and names what it found for %s', async (_name, runs, described) => {
    const { made, result } = check(runs);
    expect(await result).toBe(1);
    expect(made.err.join('')).toContain(described);
    expect(made.out).toEqual([]);
  });

  it.each([
    ['no run', []],
    ['a run of another commit', [found({ head_sha: 'def' })]],
    ['a run of another branch', [found({ head_branch: 'feature' })]],
    ['a pull request run', [found({ event: 'pull_request' })]],
    ['a run from a fork whose branch is named main', [found({ head_repository: { full_name: 'someone/repo' } })]],
  ])('exits 1 for %s, which is not a CI run of this commit on main', async (_name, runs) => {
    const { made, result } = check(runs);
    expect(await result).toBe(1);
    expect(made.err.join('')).toContain('has no CI run');
  });

  it('is green when one of several runs of the commit succeeded', async () => {
    expect(await check([found({ id: 1, conclusion: 'failure' }), found({ id: 2 })]).result).toBe(0);
  });

  it.each([
    ['a network error', new Error('MARKER_NETWORK'), 'the request failed'],
    ['a rate limit', { status: 403, body: { message: 'rate limit' } }, 'HTTP 403'],
    ['a server error', { status: 500, body: undefined }, 'HTTP 500'],
    ['an answer that is not a list of runs', { status: 200, body: { message: 'x' } }, 'an unexpected answer'],
  ])('exits 1 and never treats %s as green', async (_name, answer, message) => {
    const { made, result } = check([], { answer });
    expect(await result).toBe(1);
    expect(made.err.join('')).toContain(message);
    expect(made.err.join('')).not.toContain('MARKER_NETWORK');
  });

  it('exits 1 when GITHUB_REPOSITORY does not name a repository, and asks for nothing', async () => {
    const { made, result } = check([found()], { env: {} });
    expect(await result).toBe(1);
    expect(made.requests).toEqual([]);
  });

  it('exits 1 for a tag that does not exist', async () => {
    const made = harness({ script: { git: { 'rev-parse v0.1.0^{commit}': { status: 1 } } }, env });
    expect(await release.checkCi(['--tag', 'v0.1.0', '--check-ci'], made.deps)).toBe(1);
    expect(made.requests).toEqual([]);
  });

  it('never prints the token', async () => {
    for (const answer of [{ status: 200, body: { workflow_runs: [found()] } }, { status: 403, body: undefined }, new Error('x')]) {
      const { made, result } = check([], { answer });
      await result;
      expect(made.out.join('') + made.err.join('')).not.toContain('MARKER_TOKEN');
    }
  });

  it('is reached through main, and run alone refuses the mode', async () => {
    const made = harness({ script: { git }, env, answer: { status: 200, body: { workflow_runs: [found()] } } });
    expect(await release.main(['--tag', 'v0.1.0', '--check-ci'], made.deps)).toBe(0);
    const alone = harness({ script: { git }, env });
    expect(release.run(['--tag', 'v0.1.0', '--check-ci'], alone.deps)).toBe(1);
    expect(alone.calls).toEqual([]);
  });
});

describe('the archive index', () => {
  it('reads the digest of the one image index', () => {
    expect(release.archiveIndexDigest(() => INDEX)).toBe(DIGEST);
  });
  it('reads nothing from an empty or malformed index', () => {
    expect(release.archiveIndexDigest(() => JSON.stringify({ manifests: [] }))).toBeUndefined();
    expect(release.archiveIndexDigest(() => JSON.stringify({}))).toBeUndefined();
  });
});

describe('the registry and the image name live in one file', () => {
  const releaseFiles = [
    '.github/workflows/release.yml',
    'deploy/release/release-image.mjs',
    'deploy/release/release-image.d.mts',
    'deploy/release/README.md',
  ];
  const target = z
    .object({ registry: z.string(), image: z.string() })
    .parse(JSON.parse(readFileSync(join(repoRoot, release.TARGET_FILE), 'utf8')));

  it('holds either a placeholder token or a chosen value in both fields', () => {
    for (const value of Object.values(target)) expect(value.length).toBeGreaterThan(0);
  });

  it('is the only release file that names a registry host or either value once they are chosen', () => {
    const chosen = Object.values(target).filter((value) => !value.includes(release.TOKEN_PREFIX));
    for (const file of releaseFiles) {
      const content = readFileSync(join(repoRoot, file), 'utf8');
      for (const value of chosen) expect(content, file).not.toContain(value);
      expect(content, file).not.toMatch(/\b(ghcr\.io|docker\.io|quay\.io|gcr\.io|amazonaws\.com|azurecr\.io)\b/);
    }
  });

  it('spells no placeholder token in a release file other than the target file', () => {
    for (const file of releaseFiles) {
      expect(readFileSync(join(repoRoot, file), 'utf8'), file).not.toMatch(new RegExp(`${release.TOKEN_PREFIX}[A-Z0-9]`));
    }
  });
});
