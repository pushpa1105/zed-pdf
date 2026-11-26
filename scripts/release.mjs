// Release helper. Zero dependencies.
//
//   node scripts/release.mjs version <patch|minor|major|prerelease|x.y.z[-tag.n]>
//       Bumps packages/zedpdf/package.json and moves the "Unreleased" section of
//       packages/zedpdf/CHANGELOG.md under the new version heading with today's date.
//   node scripts/release.mjs notes [x.y.z]
//       Prints the CHANGELOG section for a version (default: current) — used for GitHub Release notes.
//   node scripts/release.mjs check-tag <vX.Y.Z>
//       Fails unless the tag matches the package version and the CHANGELOG has an entry for it.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PKG = resolve(root, 'packages/zedpdf/package.json');
const LOG = resolve(root, 'packages/zedpdf/CHANGELOG.md');
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

const pkg = JSON.parse(readFileSync(PKG, 'utf8'));
const log = readFileSync(LOG, 'utf8').replace(/\r\n/g, '\n');
const repo = (pkg.repository?.url ?? '').replace(/^git\+/, '').replace(/\.git$/, '');

const fail = (msg) => {
  console.error(`release: ${msg}`);
  process.exit(1);
};
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function bump(current, kind) {
  if (SEMVER.test(kind)) return kind;
  const m = current.match(SEMVER);
  if (!m) fail(`current version "${current}" is not semver`);
  let [major, minor, patch] = m.slice(1, 4).map(Number);
  const pre = m[4];
  switch (kind) {
    case 'major': return `${major + 1}.0.0`;
    case 'minor': return `${major}.${minor + 1}.0`;
    case 'patch': return pre ? `${major}.${minor}.${patch}` : `${major}.${minor}.${patch + 1}`;
    case 'prerelease': {
      if (!pre) return `${major}.${minor}.${patch + 1}-beta.0`;
      const parts = pre.split('.');
      const last = Number(parts.at(-1));
      return Number.isInteger(last)
        ? `${major}.${minor}.${patch}-${[...parts.slice(0, -1), last + 1].join('.')}`
        : `${major}.${minor}.${patch}-${pre}.0`;
    }
    default: fail(`unknown bump "${kind}" (use patch, minor, major, prerelease or an exact x.y.z)`);
  }
}

/** Body of the "## [heading]" section, up to the next "## [" heading or the link references. */
function section(heading) {
  const re = new RegExp(`^## \\[${esc(heading)}\\][^\\n]*\\n([\\s\\S]*?)(?=^## \\[|^\\[[^\\]]+\\]: |(?![\\s\\S]))`, 'm');
  const m = log.match(re);
  return m ? m[1].trim() : null;
}

const [cmd, arg] = process.argv.slice(2);

if (cmd === 'version') {
  if (!arg) fail('usage: release.mjs version <patch|minor|major|prerelease|x.y.z>');
  const prev = pkg.version;
  const next = bump(prev, arg);
  if (next === prev) fail(`version is already ${prev}`);
  if (section(next) !== null) fail(`CHANGELOG already has a ${next} section`);
  const unreleased = section('Unreleased');
  if (unreleased === null) fail('CHANGELOG has no "## [Unreleased]" section');
  if (!unreleased && !process.argv.includes('--allow-empty')) {
    fail('"Unreleased" is empty. Describe the changes first (or pass --allow-empty).');
  }
  const date = new Date().toLocaleDateString('sv-SE'); // local YYYY-MM-DD
  let out = log.replace(/^## \[Unreleased\][^\n]*\n/m, `## [Unreleased]\n\n## [${next}] - ${date}\n`);
  // Link references: Unreleased compares from the new tag; add one for the new version.
  if (repo) {
    const unrelLink = `[Unreleased]: ${repo}/compare/v${next}...HEAD`;
    const verLink = `[${next}]: ${repo}/compare/v${prev}...v${next}`;
    out = /^\[Unreleased\]: .*$/m.test(out)
      ? out.replace(/^\[Unreleased\]: .*$/m, `${unrelLink}\n${verLink}`)
      : `${out.trimEnd()}\n\n${unrelLink}\n${verLink}\n`;
  }
  out = out.replace(/\n{3,}/g, '\n\n');
  writeFileSync(LOG, out);
  pkg.version = next;
  writeFileSync(PKG, JSON.stringify(pkg, null, 2) + '\n');
  console.log(`zedpdf ${prev} → ${next}

Next steps:
  pnpm check                                   # optional locally; CI runs it too
  git add -A && git commit -m "release: v${next}"
  git tag v${next}
  git push && git push origin v${next}         # the Release workflow publishes to npm`);
} else if (cmd === 'notes') {
  const v = (arg ?? pkg.version).replace(/^v/, '');
  const body = section(v);
  if (body === null) fail(`no CHANGELOG section for ${v}`);
  process.stdout.write(`${body}\n\n---\n\nInstall: \`npm install zedpdf@${v}\` · [Changelog](${repo}/blob/v${v}/packages/zedpdf/CHANGELOG.md)\n`);
} else if (cmd === 'check-tag') {
  const v = (arg ?? '').replace(/^refs\/tags\//, '').replace(/^v/, '');
  if (!SEMVER.test(v)) fail(`tag "${arg}" is not vX.Y.Z`);
  if (v !== pkg.version) fail(`tag v${v} does not match packages/zedpdf/package.json version ${pkg.version}`);
  if (!section(v)) fail(`CHANGELOG has no entry for ${v}`);
  console.log(`ok: v${v}`);
} else {
  fail('usage: release.mjs <version|notes|check-tag> [arg]');
}
