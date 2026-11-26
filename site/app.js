// Landing page: install/code tabs and the live playground (runs the real zedpdf build in this tab).
import { pdf, ZedPdfError, VERSION } from './lib/zedpdf.js';
import { renderInvoice, PRESETS } from './fixtures/invoice.js';
import { initTabs } from './ui.js';

const $ = (s) => document.querySelector(s);
for (const el of document.querySelectorAll('#version')) el.textContent = `v${VERSION}`;
$('#ver').textContent = `v${VERSION}`;
initTabs();

// ---- install tabs
for (const b of document.querySelectorAll('.install [role=tab]')) {
  b.addEventListener('click', () => {
    for (const x of document.querySelectorAll('.install [role=tab]')) x.setAttribute('aria-selected', String(x === b));
    $('#install-cmd').textContent = b.dataset.install;
  });
}

// ---- playground
const form = $('#controls');
const mount = $('#mount');

function settings() {
  const f = new FormData(form);
  return {
    preset: f.get('preset'),
    format: f.get('format'),
    orientation: f.get('orientation'),
    margin: f.get('margin') === '0' ? 0 : f.get('margin'),
    footer: f.get('footer') === 'on',
  };
}

function render() {
  const s = settings();
  renderInvoice(mount, { preset: s.preset, base: new URL('./fixtures/', import.meta.url).href });
  $('#html-meta').textContent = `${PRESETS[s.preset].rows} rows`;
}
form.preset.addEventListener('change', render);

// The on-screen invoice is laid out at the A4 printable width and zoomed to fit its pane.
// zedpdf ignores ancestor zoom/transforms, so the export is unaffected.
const htmlView = document.querySelector('.html-view');
const paper = document.querySelector('.paper');
new ResizeObserver(() => {
  paper.style.zoom = String(Math.min(1, (htmlView.clientWidth - 36) / paper.offsetWidth));
}).observe(htmlView);

const FOOTER =
  '<div style="font:10px \'Noto Sans\',sans-serif;color:#627084;display:flex;justify-content:space-between;padding-top:6px;border-top:1px solid #d5dce4">' +
  '<span>Himal Trading Co. · INV-2026-0042</span><span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span></div>';

function options(s) {
  return {
    format: s.format,
    orientation: s.orientation,
    margin: s.margin,
    title: 'Invoice INV-2026-0042',
    complexScriptFallback: 'raster',
    footer: s.footer ? { html: FOOTER } : undefined,
    onProgress: (stage) => ($('#stats').textContent = `Working: ${stage}…`),
  };
}

function setBusy(on) {
  for (const id of ['#generate', '#download', '#print']) $(id).disabled = on;
}

function showWarnings(list) {
  const ul = $('#warnings');
  ul.replaceChildren();
  for (const w of list) {
    const li = document.createElement('li');
    li.className = w.severity;
    const code = document.createElement('code');
    code.textContent = w.code;
    const msg = document.createElement('span');
    msg.textContent = w.message + (w.count > 1 ? ` (×${w.count})` : '');
    const small = document.createElement('small');
    small.textContent = [w.element, w.remedy].filter(Boolean).join(' · ');
    li.append(code, msg, small);
    ul.appendChild(li);
  }
}

async function generate() {
  setBusy(true);
  showWarnings([]);
  const t0 = performance.now();
  try {
    // The playground uses the same API you would: pdf(element).render() returns the file and its actions.
    const res = await pdf(mount.querySelector('#invoice'), options(settings())).render();
    const ms = performance.now() - t0;
    $('#stats').innerHTML = `<b>${res.pageCount}</b> page${res.pageCount > 1 ? 's' : ''} · <b>${(res.blob.size / 1024).toFixed(0)} KB</b> · built in <b>${ms.toFixed(0)} ms</b> in this tab`;
    showWarnings(res.warnings);
    return res;
  } catch (e) {
    $('#stats').textContent = e instanceof ZedPdfError ? `Export failed: ${e.message}` : `Unexpected error: ${e?.message ?? e}`;
    if (e instanceof ZedPdfError) showWarnings(e.warnings);
    return null;
  } finally {
    setBusy(false);
  }
}

$('#generate').addEventListener('click', async () => {
  const res = await generate();
  if (!res) return;
  res.preview('#pdf'); // manages the object URL and releases the previous one
  $('#pdf').hidden = false;
  $('#empty').hidden = true;
  $('#open-tab').href = $('#pdf').src;
  $('#open-tab').hidden = false;
});

$('#download').addEventListener('click', async () => {
  const res = await generate();
  if (res) res.download(`zedpdf-invoice-${settings().preset}.pdf`);
});

$('#print').addEventListener('click', async () => {
  const s = settings();
  setBusy(true);
  try {
    await pdf(mount.querySelector('#invoice'), { format: s.format, orientation: s.orientation, margin: s.margin, title: 'Invoice INV-2026-0042' }).print();
  } finally {
    setBusy(false);
  }
});

render();
document.documentElement.dataset.ready = '1';
