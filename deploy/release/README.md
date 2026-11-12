# deploy/release

How a release image is built and published. A maintainer pushes a version tag; the release workflow ([`.github/workflows/release.yml`](../../.github/workflows/release.yml)) builds the image from that tag and publishes it. The workflow runs on a push of a tag named `v<major>.<minor>.<patch>` and on nothing else, and it changes nothing else: it creates no commit, tag, release or setting.

## What the workflow does, in order

1. Checks out the tag with its full history and installs the dependencies.
2. Checks that the tagged commit has a green CI run: `node deploy/release/release-image.mjs --tag "$GITHUB_REF_NAME" --check-ci`. It reads the runs of `ci.yml` for that commit (a completed run from a push to this repository on `main` that succeeded) and publishes nothing if there is none. See *A tag needs a green CI run* below.
3. Runs `pnpm test:image`, then the README quickstart test (`pnpm test:compose src/compose/readme-quickstart.compose.test.ts`; CI runs it only when the README, `deploy/` or the files the test reads change, so a release runs it too).
4. Makes `skopeo` available (it installs it when the runner image lacks it).
5. Checks the image target: `node deploy/release/release-image.mjs --tag "$GITHUB_REF_NAME" --check-target`.
6. Logs in to the registry with the workflow's own `GITHUB_TOKEN` (no personal token is stored). The job asks for `packages: write` and for `actions: read` (to read the CI runs) in addition to read access to the contents, and for nothing else.
7. Pushes the image: `node deploy/release/release-image.mjs --tag "$GITHUB_REF_NAME" --push`. The script refuses unless `HEAD` is on `origin/main` and the tag points at `HEAD`. It builds one OCI archive for `linux/amd64` and `linux/arm64` (CI builds the arm64 image only when `pnpm-lock.yaml`, a `package.json` at the root, `.nvmrc`, a file under `deploy/` or `.github/workflows/` changed, as `tools/ci/changed-paths.mjs` decides, and relies on this build otherwise), runs the platform check on it, searches every layer for a release placeholder that was not replaced (a hit stops the run), then pushes that same archive with `skopeo copy --all` as `<registry>/<image>:<version>` (the tag without its `v`; there is no `latest`). The pushed digest must equal the archive's index digest. The image reference and digest go to the run's summary.

## A tag needs a green CI run

CI runs on pushes to branches and pull requests, and not on tags. A release therefore relies on the run its commit already had on `main`. The release workflow reads the runs of `ci.yml` for the tagged commit (`GET /repos/<owner>/<repo>/actions/workflows/ci.yml/runs?head_sha=<sha>&branch=main&event=push`) and stops before it builds or publishes anything unless one of them is completed with the conclusion `success`, comes from a push and belongs to this repository (a run of a pull request or of a fork whose branch is also named `main` does not count). It never treats an answer it cannot read as green.

A tag pushed while CI still runs for its commit fails this check; run the release again once CI is green. The check by hand, with `GITHUB_TOKEN` set to a token that can read the repository's Actions runs:

```sh
curl -s -H "Authorization: Bearer $GITHUB_TOKEN" "https://api.github.com/repos/<owner>/<repo>/actions/workflows/ci.yml/runs?head_sha=$(git rev-parse v<version>^{commit})&branch=main&event=push" | grep -E '"(conclusion|status)"'
```

A run of the commit with `"status": "completed"` and `"conclusion": "success"` is green; anything else, or no run, publishes nothing.

## The image target

[`image-target.json`](image-target.json) names the registry host (`registry`) and the image path (`image`). It is the only place either appears. Both are chosen. If either field holds a release placeholder (a name starting `NEBURYX_RELEASE_` and ending `_REGISTRY` or `_IMAGE`) or is empty, `--check-target` and `--push` exit `1` and the workflow stops at step 3, before it logs in.

## Local dry run

A dry run builds the image the way the workflow does and publishes nothing. It needs Docker with Buildx.

```bash
pnpm install --frozen-lockfile
```

```bash
pnpm test:image
```

```bash
node deploy/release/release-image.mjs --tag v0.1.0 --dry-run
```

The last command builds one OCI archive for both platforms, runs the platform check and the left-over placeholder search on it, and prints `dry run: nothing was published`. The dry run therefore fails while a release placeholder is still in the app. It makes no push, no login and no `skopeo` call.
