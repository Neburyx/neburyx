# deploy/release

How a release image is built and published. A maintainer pushes a version tag; the release workflow ([`.github/workflows/release.yml`](../../.github/workflows/release.yml)) builds the image from that tag and publishes it. The workflow runs on a push of a tag named `v<major>.<minor>.<patch>` and on nothing else, and it changes nothing else: it creates no commit, tag, release or setting.

## What the workflow does, in order

1. Checks out the tag with its full history, installs the dependencies and runs `pnpm test:image`.
2. Makes `skopeo` available (it installs it when the runner image lacks it).
3. Checks the image target: `node deploy/release/release-image.mjs --tag "$GITHUB_REF_NAME" --check-target`.
4. Logs in to the registry with the secrets `REGISTRY_USERNAME` and `REGISTRY_TOKEN`.
5. Pushes the image: `node deploy/release/release-image.mjs --tag "$GITHUB_REF_NAME" --push`. The script refuses unless `HEAD` is on `origin/main` and the tag points at `HEAD`. It builds one OCI archive for `linux/amd64` and `linux/arm64`, runs the platform check on it, searches every layer for a release placeholder that was not replaced (a hit stops the run), then pushes that same archive with `skopeo copy --all` as `<registry>/<image>:<version>` (the tag without its `v`; there is no `latest`). The pushed digest must equal the archive's index digest. The image reference and digest go to the run's summary.

## The image target

[`image-target.json`](image-target.json) names the registry host (`registry`) and the image path (`image`). It is the only place either appears. Both are not yet chosen: each holds a release placeholder (a name starting `NEBURYX_RELEASE_` and ending `_REGISTRY` or `_IMAGE`) until a maintainer replaces it. While either does, `--check-target` and `--push` exit `1` and the workflow stops at step 3, before it logs in.

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
