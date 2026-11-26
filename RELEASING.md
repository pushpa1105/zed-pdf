# Releasing zedpdf

Releases are cut from `main` by pushing a version tag. GitHub Actions does the rest:

| Workflow | Trigger | What it does |
|---|---|---|
| [`ci.yml`](.github/workflows/ci.yml) | push to `main`, pull requests | build, typecheck, unit tests, site build, Playwright (Chromium + Firefox/WebKit `@compat`) |
| [`pages.yml`](.github/workflows/pages.yml) | push to `main` touching the site, library, changelog or samples; manual | builds `dist-site/` and deploys it to GitHub Pages |
| [`release.yml`](.github/workflows/release.yml) | push of a `v*` tag | checks the tag against `package.json` and `CHANGELOG.md`, runs the tests, publishes to npm with provenance, creates a GitHub Release with the changelog notes and the tarball |

## One-time setup

1. **Repository.** Push this repo to GitHub. If the URL is not `https://github.com/pushpa1105/zed-pdfer`, change `homepage`, `repository` and `bugs` in [`packages/zedpdf/package.json`](packages/zedpdf/package.json), the links at the top of [`packages/zedpdf/README.md`](packages/zedpdf/README.md) and the link references at the bottom of [`CHANGELOG.md`](packages/zedpdf/CHANGELOG.md). The site reads the repository URL from `package.json`, so it needs no edits.
2. **Default branch** is `main` (`git branch -M main` if your local branch is still `master`).
3. **GitHub Pages.** Settings → Pages → Build and deployment → Source: **GitHub Actions**. The site will be served at `https://<user>.github.io/<repo>/`. All site links are relative, so any repository name works.
4. **npm auth.** Choose one:
   - **Token (simplest, needed for the very first publish from CI).** Create a granular access token on npmjs.com with read and write access to packages, then add it as the repository secret `NPM_TOKEN` (Settings → Secrets and variables → Actions).
   - **Trusted publishing (recommended once the package exists).** On npmjs.com → zedpdf → Settings → Trusted publisher, add GitHub Actions with this repository and the workflow file `release.yml`. You can then delete the `NPM_TOKEN` secret.

## Cutting a release

Every user-visible change should already be listed under `## [Unreleased]` in [`packages/zedpdf/CHANGELOG.md`](packages/zedpdf/CHANGELOG.md) (see [Writing changelog entries](#writing-changelog-entries)).

```sh
git switch main && git pull
pnpm release:version minor        # or: patch | major | prerelease | 0.3.0 | 1.0.0-rc.1
#   → bumps packages/zedpdf/package.json
#   → moves "Unreleased" under "## [x.y.z] - today" and updates the compare links
git diff                          # review the bump and the changelog
pnpm check                        # optional: CI runs the same tests before publishing
git commit -am "release: v0.2.0"
git tag v0.2.0
git push origin main v0.2.0
```

Then watch the **Release** workflow in the Actions tab. When it finishes:

- `npm view zedpdf version` shows the new version.
- The GitHub Releases page has `zedpdf v0.2.0` with the changelog section and the `.tgz` attached.
- The site (deployed by the push to `main`) shows the new version in the header and on `changelog.html`.

### The first release (0.1.0)

`0.1.0` is already set in `package.json`, and `CHANGELOG.md` already has its entry, so skip `release:version`:

```sh
git add -A && git commit -m "release: v0.1.0"
git branch -M main
git remote add origin https://github.com/pushpa1105/zed-pdfer.git
git push -u origin main           # CI + site deploy
git tag v0.1.0 && git push origin v0.1.0   # npm publish + GitHub Release
```

If you would rather publish the first version by hand, run `pnpm check`, then `cd packages/zedpdf && npm publish`, and push the tag afterwards. The workflow sees that the version is already on npm, skips publishing, and still creates the GitHub Release.

### Pre-releases

`pnpm release:version prerelease` produces `x.y.z-beta.0`, then `-beta.1` on the next run, and so on. Exact versions such as `1.0.0-rc.1` also work. Tags containing `-` are published under the npm dist-tag **`next`**, so `npm install zedpdf` keeps installing the stable version. They are also marked as pre-releases on GitHub. Users opt in with `npm install zedpdf@next`.

### If something goes wrong

- **The tag check fails** ("tag does not match"). Delete the tag (`git tag -d vX && git push origin :refs/tags/vX`), fix the version or changelog, commit, then tag again.
- **Tests fail in the release job.** Nothing was published. Fix the problem on `main`, delete and recreate the tag on the fixed commit.
- **npm publish succeeded but a later step failed.** Re-run the workflow. Publishing is skipped when the version already exists, and the GitHub Release is created or updated.
- **A bad version reached npm.** Don't unpublish. Run `npm deprecate zedpdf@x.y.z "reason; use x.y.z+1"` and release a patch.

## Versioning policy

zedpdf follows [Semantic Versioning](https://semver.org/).

- **Patch** (`0.1.1`). Bug fixes and fidelity improvements that don't change the API. The PDF output may change if it becomes more correct.
- **Minor** (`0.2.0`). New options, functions, warning codes or CSS support. While below 1.0, a minor release may also contain breaking changes. Those are always listed under **Breaking**, with migration steps.
- **Major** (from 1.0 on). Breaking API changes, removing a supported browser, or changing default options in a way that alters output.

Changing a warning `code` string, an error `code`, or a default option value counts as breaking.

## Writing changelog entries

Add entries under `## [Unreleased]` in the same pull request as the change. Use the Keep a Changelog groups. The site styles these headings:

```md
## [Unreleased]

### Breaking
- `margin` now defaults to `'10mm'` (was `0`). Pass `margin: 0` to keep the old output.

### Added
- `format: 'B5'`.

### Fixed
- Table headers no longer repeat on a page that only holds the table's last border.
```

The groups are `Breaking`, `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed` and `Security`. Write each entry for the person upgrading: what changed and what they need to do. The same text becomes the GitHub Release notes (`pnpm release:notes`) and the site's changelog page.

## Updating the site and docs

- The site source is `site/`. `pnpm site` builds it into `dist-site/`, and `pnpm site:preview` serves it at `http://127.0.0.1:4792/`.
- `{{VERSION}}` and `{{REPO}}` in `site/*.html` are filled in at build time from `packages/zedpdf/package.json`, so the version badge and the CDN snippet never go stale.
- `changelog.html` is generated from `CHANGELOG.md`, so don't edit the release list by hand.
- Document new options in `site/docs.html` (the API reference and option tables) **and** `packages/zedpdf/README.md` (shown on npm) in the same pull request as the code.
- The comparison images and figures on the landing page come from `samples/`. After a change that affects rendering, regenerate them with `pnpm m1`, `pnpm samples` and (optionally) `cd research/compare && npm install && node run.mjs`, then commit the updated `samples/`.
