import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const TAG_RULE = /^v\d+\.\d+\.\d+$/;
export const TOKEN_PREFIX = ['NEBURYX_RELEASE', 'PLACEHOLDER', ''].join('_');
const TOKEN_PATTERN = `${TOKEN_PREFIX}[A-Z0-9]`;
const ZSTD_EXIT = 3;
export const SCAN_BLOB = [
  'magic=$(head -c 4 "$1" | od -An -tx1 | tr -d " \\n")',
  'case $magic in 28b52ffd*) exit 3 ;; esac',
  'case $magic in 1f8b*) gzip -t "$1" 2> /dev/null || exit 3; gzip -dc "$1" | grep -aqE "$2" ;; *) grep -aqE "$2" "$1" ;; esac',
  'found=$?',
  '[ "$found" -eq 0 ] && exit 1',
  '[ "$found" -gt 1 ] && exit 3',
  'exit 0',
].join("\n");
export const TARGET_FILE = 'deploy/release/image-target.json';
export const PLATFORMS = 'linux/amd64,linux/arm64';
const DOCKERFILE = 'deploy/docker/Dockerfile';
const PLATFORM_CHECK = 'deploy/docker/check-platforms.mjs';
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const MODES = { '--dry-run': 'dry-run', '--push': 'push', '--check-target': 'check-target' };
const USAGE = 'usage: release-image.mjs --tag v<major>.<minor>.<patch> [--dry-run | --push | --check-target]';

export function parseArgs(argv) {
  let tag;
  const modes = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--tag') {
      tag = argv[index + 1];
      index += 1;
    } else if (Object.hasOwn(MODES, argument)) {
      modes.push(MODES[argument]);
    } else {
      return { ok: false, message: `unknown option ${argument}\n${USAGE}` };
    }
  }
  if (tag === undefined) return { ok: false, message: `--tag is required\n${USAGE}` };
  if (modes.length > 1) return { ok: false, message: `give at most one mode\n${USAGE}` };
  return { ok: true, tag, mode: modes[0] ?? 'dry-run' };
}

export function tagProblem(tag) {
  if (TAG_RULE.test(tag)) return undefined;
  return `the tag must look like v<major>.<minor>.<patch>, for example v1.2.3`;
}

export function versionOf(tag) {
  return tag.slice(1);
}

export function readTarget(readFile) {
  let parsed;
  try {
    parsed = JSON.parse(readFile(TARGET_FILE));
  } catch {
    return { problem: `${TARGET_FILE} cannot be read as JSON` };
  }
  for (const field of ['registry', 'image']) {
    const value = parsed?.[field];
    if (typeof value !== 'string' || value.trim() === '' || value.includes(TOKEN_PREFIX)) {
      return { problem: `${TARGET_FILE}: \`${field}\` is not yet chosen` };
    }
  }
  return { target: { registry: parsed.registry.trim(), image: parsed.image.trim() } };
}

export function imageReference(target, tag) {
  return `${target.registry}/${target.image}:${versionOf(tag)}`;
}

export function buildCommand(archive) {
  return ['docker', ['buildx', 'build', '--platform', PLATFORMS, '-f', DOCKERFILE, '--output', `type=oci,dest=${archive}`, '.']];
}

export function platformCheckCommand(archive) {
  return ['node', [PLATFORM_CHECK, archive]];
}

export function pushCommand(archive, digestFile, reference) {
  return ['skopeo', ['copy', '--all', '--digestfile', digestFile, `oci-archive:${archive}`, `docker://${reference}`]];
}

export function archiveIndexDigest(readFile) {
  let manifests;
  try {
    manifests = JSON.parse(readFile('index.json')).manifests ?? [];
  } catch {
    return undefined;
  }
  if (manifests.length !== 1 || typeof manifests[0].digest !== 'string') return undefined;
  return manifests[0].digest;
}

function succeeded(result) {
  return result.status === 0;
}

function guardProblem(exec, tag) {
  const head = exec('git', ['rev-parse', 'HEAD'], { capture: true });
  if (!succeeded(head)) return 'cannot read HEAD';
  if (!succeeded(exec('git', ['merge-base', '--is-ancestor', 'HEAD', 'origin/main'], { capture: true }))) {
    return 'HEAD is not on origin/main';
  }
  const tagged = exec('git', ['rev-parse', `${tag}^{commit}`], { capture: true });
  if (!succeeded(tagged) || tagged.stdout.trim() !== head.stdout.trim()) return `the tag ${tag} does not point at HEAD`;
  return undefined;
}

function leftoverToken(deps, archive, workDir) {
  const extracted = join(workDir, 'archive');
  if (!succeeded(deps.exec('mkdir', ['-p', extracted], {})) || !succeeded(deps.exec('tar', ['-xf', archive, '-C', extracted], {}))) {
    return 'the image archive could not be unpacked';
  }
  for (const blob of deps.listDir(join(extracted, 'blobs', 'sha256'))) {
    const { status } = deps.exec('sh', ['-c', SCAN_BLOB, 'scan', join(extracted, 'blobs', 'sha256', blob), TOKEN_PATTERN], {});
    if (status === ZSTD_EXIT) return 'a layer of the image cannot be searched for a left-over placeholder';
    if (status !== 0) return 'the image holds a placeholder that was not replaced';
  }
  return undefined;
}

function buildAndCheck(deps, archive, workDir) {
  const [buildTool, buildArgs] = buildCommand(archive);
  if (!succeeded(deps.exec(buildTool, buildArgs, {}))) return 'the image build failed';
  const [checkTool, checkArgs] = platformCheckCommand(archive);
  if (!succeeded(deps.exec(checkTool, checkArgs, {}))) return 'the platform check failed';
  return leftoverToken(deps, archive, workDir);
}

function readDigest(deps, digestFile) {
  try {
    return deps.readFile(digestFile).trim();
  } catch {
    return '';
  }
}

function pushChecked(deps, archive, reference, workDir) {
  const digestFile = join(workDir, 'digest.txt');
  const [tool, args] = pushCommand(archive, digestFile, reference);
  if (!succeeded(deps.exec(tool, args, {}))) return { problem: 'the push failed' };
  const written = readDigest(deps, digestFile);
  const checked = archiveIndexDigest((path) => deps.exec('tar', ['-xOf', archive, path], { capture: true }).stdout);
  if (!DIGEST_PATTERN.test(written)) return { problem: 'the push wrote no digest' };
  if (written !== checked) return { problem: 'the pushed digest differs from the checked archive' };
  return { digest: written };
}

function runPush(deps, tag) {
  const { target, problem } = readTarget(deps.readFile);
  if (problem !== undefined) return fail(deps, problem);
  const guard = guardProblem(deps.exec, tag);
  if (guard !== undefined) return fail(deps, guard);
  const workDir = deps.makeTempDir();
  try {
    const archive = join(workDir, 'neburyx.oci.tar');
    const built = buildAndCheck(deps, archive, workDir);
    if (built !== undefined) return fail(deps, built);
    const reference = imageReference(target, tag);
    const pushed = pushChecked(deps, archive, reference, workDir);
    if (pushed.problem !== undefined) return fail(deps, pushed.problem);
    deps.stdout(`image: ${reference}\ndigest: ${pushed.digest}\n`);
    return 0;
  } finally {
    deps.removeDir(workDir);
  }
}

function runDry(deps) {
  const workDir = deps.makeTempDir();
  try {
    const built = buildAndCheck(deps, join(workDir, 'neburyx.oci.tar'), workDir);
    if (built !== undefined) return fail(deps, built);
    deps.stdout('dry run: nothing was published\n');
    return 0;
  } finally {
    deps.removeDir(workDir);
  }
}

function fail(deps, message) {
  deps.stderr(`${message}\n`);
  return 1;
}

export function run(argv, deps) {
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    deps.stderr(`${parsed.message}\n`);
    return 2;
  }
  const rule = tagProblem(parsed.tag);
  if (rule !== undefined) {
    deps.stderr(`${rule}\n`);
    return 2;
  }
  if (parsed.mode === 'check-target') {
    const { target, problem } = readTarget(deps.readFile);
    if (problem !== undefined) return fail(deps, problem);
    deps.stdout(`registry: ${target.registry}\n`);
    return 0;
  }
  return parsed.mode === 'push' ? runPush(deps, parsed.tag) : runDry(deps);
}

function realDeps() {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  return {
    exec: (tool, args, options) => {
      const result = spawnSync(tool, args, {
        cwd: root,
        encoding: 'utf8',
        stdio: options.capture ? ['ignore', 'pipe', 'inherit'] : ['ignore', 2, 2],
      });
      return { status: result.status ?? 1, stdout: result.stdout ?? '' };
    },
    readFile: (path) => readFileSync(isAbsolute(path) ? path : join(root, path), 'utf8'),
    listDir: (path) => readdirSync(path),
    makeTempDir: () => mkdtempSync(join(tmpdir(), 'neburyx-release-')),
    removeDir: (path) => rmSync(path, { recursive: true, force: true }),
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = run(process.argv.slice(2), realDeps());
}
