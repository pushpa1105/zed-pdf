// Styling context, print rules on the direct path, PNG transparency and image de-duplication.
import { test, expect } from '@playwright/test';
import { open, exportInPage, extract, render, pdfObjects } from './helpers.mjs';

function pixel(img, xPt, yPt, dpi) {
  const s = dpi / 72;
  const x = Math.round(xPt * s);
  const y = Math.round(yPt * s);
  const k = (y * img.width + x) * 4;
  return [img.rgba[k], img.rgba[k + 1], img.rgba[k + 2]];
}
const near = (a, b, tol = 3) => a.every((v, i) => Math.abs(v - b[i]) <= tol);

test('Vue scoped styles (data-v attributes) are applied in the export', async ({ page }) => {
  await open(page, '/fixtures/context.html');
  const r = await exportInPage(page, '#vue-card', { format: 'A4', margin: 0 });
  const img = render(r.bytes, 144)[0];
  // 3px green border at the card's left edge (x = 1.5px), heading in green.
  expect(near(pixel(img, 1.5 * 0.75, 40 * 0.75, 144), [10, 120, 60], 6)).toBe(true);
  const text = (await extract(r.bytes))[0].text;
  expect(text).toContain('Scoped Vue heading');
});

test('React theme inherited from an ancestor: class selector, CSS variables and font', async ({ page }) => {
  await open(page, '/fixtures/context.html');
  const r = await exportInPage(page, '#react-invoice', { format: 'A4', margin: 0 });
  const img = render(r.bytes, 144)[0];
  expect(near(pixel(img, 3, 3, 144), [20, 24, 33])).toBe(true); // var(--surface) background
  const objs = pdfObjects(r.bytes);
  expect(objs.some((o) => /BaseFont \/[A-Z]{6}\+NotoSans/.test(o.dict))).toBe(true); // inherited font embedded
  const content = objs.filter((o) => o.data && /Filter \/FlateDecode \/Length \d+ >>/.test(o.dict) && !/Length1|Subtype/.test(o.dict)).map((o) => o.data.toString('latin1')).join('\n');
  expect(content).toContain('0.8627 0.1569 0.3922 rg'); // var(--accent) heading colour
  expect(r.warnings.filter((w) => w.severity !== 'info')).toEqual([]);
});

test('direct path applies @media print rules and disables @media screen; media:"screen" keeps the screen cascade', async ({ page }) => {
  await open(page, '/fixtures/context.html');
  const p = await exportInPage(page, '#react-invoice', {});
  const t = (await extract(p.bytes))[0].text;
  expect(t).toContain('PRINT-ONLY-LINE');
  expect(t).not.toContain('SCREEN-ONLY-LINE');
  const s = await exportInPage(page, '#react-invoice', { media: 'screen' });
  const t2 = (await extract(s.bytes))[0].text;
  expect(t2).toContain('SCREEN-ONLY-LINE');
  expect(t2).not.toContain('PRINT-ONLY-LINE');
  // Export-only CSS hook.
  const c = await exportInPage(page, '#react-invoice', { css: '.inv h2 { display: none }' });
  expect((await extract(c.bytes))[0].text).not.toContain('Themed React heading');
});

test('PNG transparency is preserved and a repeated image is embedded once', async ({ page }) => {
  await open(page, '/fixtures/context.html');
  const r = await exportInPage(page, '#transp', { format: 'A4', margin: 0 });
  const objs = pdfObjects(r.bytes);
  const images = objs.filter((o) => /\/Subtype \/Image/.test(o.dict));
  expect(images.length).toBe(2); // one RGB image + its SMask, despite two <img> uses
  expect(images.some((o) => /\/SMask \d+ 0 R/.test(o.dict))).toBe(true);
  const img = render(r.bytes, 144)[0];
  // Top-left corner of the logo is fully transparent: the background colour shows through.
  expect(near(pixel(img, 2, 2, 144), [255, 230, 200])).toBe(true);
  // Second copy (below the first, 80px down) shows the same.
  expect(near(pixel(img, 2, (80 + 2) * 0.75, 144), [255, 230, 200])).toBe(true);
  // Opaque logo ink is present (brand blue in the mountain mark).
  let found = false;
  for (let y = 10; y < 55 && !found; y++) for (let x = 10; x < 70 && !found; x++) if (near(pixel(img, x * 0.75, y * 0.75, 144), [16, 94, 166], 12)) found = true;
  expect(found).toBe(true);
});

test('printElement opens the native print flow on a styled clone and cleans up', async ({ page }) => {
  await open(page, '/fixtures/context.html');
  const res = await page.evaluate(async () => {
    const { printElement } = await import('/packages/zedpdf/dist/zedpdf.js');
    const seen = {};
    // Intercept print() on the export surface (a real dialog cannot be driven headlessly).
    const orig = HTMLIFrameElement.prototype.focus;
    const obs = new MutationObserver((muts) => {
      for (const m of muts) for (const n of m.addedNodes) if (n.tagName === 'IFRAME') {
        const tryHook = () => {
          const w = n.contentWindow;
          if (!w) return setTimeout(tryHook, 0);
          w.print = () => {
            const d = n.contentDocument;
            seen.called = true;
            seen.text = d.body.innerText;
            seen.pageRule = [...d.querySelectorAll('style')].some((s) => /@page\{size:595\.2756pt 841\.8898pt/.test(s.textContent));
            seen.printMediaKept = [...d.styleSheets].some((sh) => { try { return [...sh.cssRules].some((r) => r.media && /print/.test(r.media.mediaText)); } catch { return false; } });
            w.dispatchEvent(new Event('afterprint'));
          };
        };
        tryHook();
      }
    });
    obs.observe(document.body, { childList: true });
    await printElement(document.querySelector('#react-invoice'), { format: 'A4' });
    obs.disconnect();
    seen.iframesAfter = document.querySelectorAll('iframe').length;
    return seen;
  });
  expect(res.called).toBe(true);
  expect(res.text).toContain('Themed React heading');
  expect(res.pageRule).toBe(true);
  expect(res.printMediaKept).toBe(true); // native print cascade: @media print left intact
  expect(res.iframesAfter).toBe(0);
});
