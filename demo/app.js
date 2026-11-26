// zedpdf demo. Plain ES modules; no bundler. Assets are local, so the demo works offline once loaded.
import { exportPdf, printElement, savePdf, ZedPdfError } from '../packages/zedpdf/dist/zedpdf.js';
import { renderInvoice, PRESETS } from '../fixtures/invoice.js';

const $ = (s) => document.querySelector(s);
const form = $('#controls');
const mount = $('#mount');
let currentUrl = null; // object URL of the previewed PDF (revoked when replaced)
let running = null; // AbortController of the export in flight

function settings() {
  const f = new FormData(form);
  return {
    preset: f.get('preset'),
    rows: +f.get('rows'),
    format: f.get('format'),
    orientation: f.get('orientation'),
    margin: f.get('margin') === '0' ? 0 : f.get('margin'),
    footer: f.get('footer') === 'on',
    complex: f.get('complex'),
    strict: f.get('strict') === 'on',
  };
}

function rerender() {
  const s = settings();
  renderInvoice(mount, { preset: s.preset, rows: s.rows, base: new URL('../fixtures/', import.meta.url).href });
}

form.preset.addEventListener('change', () => {
  form.rows.value = PRESETS[form.preset.value].rows;
  form.complex.value = form.preset.value === 'bilingual' ? 'raster' : form.complex.value;
  rerender();
});
form.rows.addEventListener('change', rerender);

function options(s, signal) {
  return {
    format: s.format,
    orientation: s.orientation,
    margin: s.margin,
    strict: s.strict,
    complexScriptFallback: s.complex,
    title: 'Invoice INV-2026-0042',
    footer: s.footer
      ? { html: '<div style="font:10px \'Noto Sans\',sans-serif;color:#627084;display:flex;justify-content:space-between;padding-top:6px;border-top:1px solid #d5dce4"><span>Himal Trading Co. · INV-2026-0042</span><span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span></div>' }
      : undefined,
    signal,
    onProgress: (stage, d) => setStats(`Working… ${stage}${d?.page ? ` ${d.page}/${d.pages}` : ''}`),
  };
}

function setStats(t) {
  $('#stats').textContent = t;
}

function showWarnings(list) {
  const ul = $('#warnings');
  ul.replaceChildren();
  for (const w of list) {
    const li = document.createElement('li');
    li.className = w.severity;
    li.innerHTML = `<code></code> <span></span>${w.count > 1 ? ` <b>×${w.count}</b>` : ''}<small></small>`;
    li.querySelector('code').textContent = w.code;
    li.querySelector('span').textContent = w.message;
    li.querySelector('small').textContent = [w.element, w.remedy].filter(Boolean).join(' — ');
    ul.appendChild(li);
  }
}

function busy(on) {
  for (const b of ['#preview', '#download', '#print']) $(b).disabled = on;
  $('#cancel').disabled = !on;
}

async function run(kind) {
  const s = settings();
  running?.abort();
  const ac = new AbortController();
  running = ac;
  busy(true);
  showWarnings([]);
  const t0 = performance.now();
  try {
    const res = await exportPdf(mount.querySelector('#invoice'), options(s, ac.signal));
    const ms = performance.now() - t0;
    setStats(`${res.pageCount} page${res.pageCount > 1 ? 's' : ''} · ${(res.blob.size / 1024).toFixed(1)} KB · ${ms.toFixed(0)} ms\n` + Object.entries(res.timings).map(([k, v]) => `${k} ${v}ms`).join(' · '));
    showWarnings(res.warnings);
    if (kind === 'download') {
      savePdf(res.blob, `invoice-${s.preset}.pdf`);
    } else {
      if (currentUrl) URL.revokeObjectURL(currentUrl);
      currentUrl = URL.createObjectURL(res.blob);
      $('#pdf').src = currentUrl;
      selectTab('pdf');
    }
  } catch (e) {
    if (e instanceof ZedPdfError) {
      setStats(e.code === 'aborted' ? 'Cancelled.' : `Export failed: ${e.message}`);
      showWarnings(e.warnings ?? []);
    } else {
      setStats(`Unexpected error: ${e?.message ?? e}`);
      console.error(e);
    }
  } finally {
    if (running === ac) running = null;
    busy(false);
  }
}

$('#preview').addEventListener('click', () => run('preview'));
$('#download').addEventListener('click', () => run('download'));
$('#cancel').addEventListener('click', () => running?.abort());
$('#print').addEventListener('click', async () => {
  const s = settings();
  busy(true);
  try {
    await printElement(mount.querySelector('#invoice'), { format: s.format, orientation: s.orientation, margin: s.margin, title: 'Invoice INV-2026-0042' });
  } finally {
    busy(false);
  }
});

function selectTab(name) {
  for (const b of document.querySelectorAll('[role=tab]')) b.setAttribute('aria-selected', String(b.dataset.tab === name));
  for (const p of document.querySelectorAll('[data-pane]')) p.hidden = p.dataset.pane !== name;
}
for (const b of document.querySelectorAll('[role=tab]')) b.addEventListener('click', () => selectTab(b.dataset.tab));
window.addEventListener('pagehide', () => currentUrl && URL.revokeObjectURL(currentUrl));

rerender();
document.documentElement.dataset.ready = '1';
