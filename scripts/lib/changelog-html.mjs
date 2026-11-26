// Renders packages/zedpdf/CHANGELOG.md (Keep a Changelog format) into HTML for the site's changelog page.
// Deliberately tiny: it supports exactly what the changelog uses — "## [version] - date", "### Group",
// "- list items" (with indented continuation lines), paragraphs, `code`, **bold** and [links](url).

const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function inline(text) {
  const parts = text.split(/(`[^`]+`)/g);
  return parts
    .map((p, i) => {
      if (i % 2) return `<code>${escapeHtml(p.slice(1, -1))}</code>`;
      return escapeHtml(p)
        .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
        .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, u) => `<a href="${u}">${t}</a>`);
    })
    .join('');
}

const slug = (v) => `v${v.replace(/[^0-9A-Za-z]+/g, '-')}`;

/** @returns {{ html: string, nav: string, latest: string | null }} */
export function renderChangelog(markdown, { repo = '' } = {}) {
  const md = markdown.replace(/\r\n/g, '\n').replace(/<!--[\s\S]*?-->/g, '');
  const lines = md.split('\n').filter((l) => !/^\[[^\]]+\]: /.test(l));
  const releases = [];
  let cur = null;
  for (const line of lines) {
    const h = line.match(/^## \[([^\]]+)\](?:\s*-\s*(\S+))?/);
    if (h) releases.push((cur = { version: h[1], date: h[2] ?? '', body: [] }));
    else if (cur) cur.body.push(line);
  }

  let latest = null;
  const sections = [];
  const nav = [];
  for (const r of releases) {
    const out = [];
    let list = null;
    let para = [];
    const flushPara = () => {
      if (para.length) out.push(`<p>${inline(para.join(' '))}</p>`);
      para = [];
    };
    const flushList = () => {
      if (list) out.push(`<ul>${list.map((li) => `<li>${inline(li)}</li>`).join('')}</ul>`);
      list = null;
    };
    for (const raw of r.body) {
      const line = raw.trimEnd();
      if (!line.trim()) { flushPara(); continue; }
      const g = line.match(/^### (.+)/);
      const item = line.match(/^[-*] (.+)/);
      if (g) {
        flushPara(); flushList();
        const name = g[1].trim();
        out.push(`<h3 class="cl-group cl-${name.toLowerCase().replace(/\W+/g, '')}">${inline(name)}</h3>`);
      } else if (item) {
        flushPara();
        (list ??= []).push(item[1]);
      } else if (list && /^\s+\S/.test(line)) {
        list[list.length - 1] += ` ${line.trim()}`;
      } else {
        flushList();
        para.push(line.trim());
      }
    }
    flushPara(); flushList();

    const unreleased = r.version.toLowerCase() === 'unreleased';
    if (unreleased && !out.length) continue; // nothing pending: don't show an empty section
    if (!unreleased) latest ??= r.version;
    const id = unreleased ? 'unreleased' : slug(r.version);
    const pre = /-/.test(r.version) && !unreleased;
    const tagLink = !unreleased && repo ? `<a class="cl-src" href="${repo}/releases/tag/v${escapeHtml(r.version)}">Release notes on GitHub</a>` : '';
    const badges = [
      r.version === latest ? '<span class="cl-badge">Latest</span>' : '',
      pre ? '<span class="cl-badge pre">Pre-release</span>' : '',
      unreleased ? '<span class="cl-badge pre">In progress</span>' : '',
    ].join('');
    sections.push(`<section id="${id}" class="cl-release">
  <header class="cl-head"><h2>${unreleased ? 'Unreleased' : escapeHtml(r.version)}</h2>${badges}${r.date ? `<time datetime="${escapeHtml(r.date)}">${escapeHtml(r.date)}</time>` : ''}</header>
  ${out.join('\n  ')}
  ${tagLink}
</section>`);
    nav.push(`<a href="#${id}">${unreleased ? 'Unreleased' : escapeHtml(r.version)}${r.date ? ` <small>${escapeHtml(r.date)}</small>` : ''}</a>`);
  }
  return { html: sections.join('\n'), nav: nav.join('\n      '), latest };
}
