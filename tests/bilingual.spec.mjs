// Nepali/English invoice: visual shaping and text extraction are separate tests.
import { test, expect } from '@playwright/test';
import * as mupdf from 'mupdf';
import { open, exportInPage } from './helpers.mjs';

const PHRASES = ['बिल गर्ने ठेगाना', 'राम बहादुर थापा (Ram Bahadur Thapa)', 'श्रीमती सीता गुरुङ (Sita Gurung)', 'क्षेत्रीय वितरण', 'लक्ष्मी श्रेष्ठ'];

function mupdfText(bytes) {
  const d = mupdf.Document.openDocument(new Uint8Array(bytes), 'application/pdf');
  let t = '';
  for (let i = 0; i < d.countPages(); i++) t += d.loadPage(i).toStructuredText('preserve-whitespace').asText();
  return t;
}

test('extraction: Devanagari conjuncts and mixed-script names extract in logical order (both modes)', async ({ page }) => {
  await open(page, '/fixtures/invoice.html?preset=bilingual');
  for (const mode of ['none', 'raster']) {
    const r = await exportInPage(page, '#invoice', { complexScriptFallback: mode });
    const t = mupdfText(r.bytes);
    for (const p of PHRASES) expect(t, `${mode}: ${p}`).toContain(p);
  }
});

test('shaping: default vector path reports unshaped complex script; raster fallback is reported as info', async ({ page }) => {
  await open(page, '/fixtures/invoice.html?preset=bilingual');
  const plain = await exportInPage(page, '#invoice', {});
  const w = plain.warnings.filter((x) => x.code === 'complex-script-unshaped');
  expect(w.length).toBeGreaterThan(0);
  expect(w[0].severity).toBe('warning');
  const strict = await page.evaluate(async () => {
    const { exportPdf } = await import('/packages/zedpdf/dist/zedpdf.js');
    try {
      await exportPdf(document.querySelector('#invoice'), { strict: true });
      return 'resolved';
    } catch (e) {
      return e.code;
    }
  });
  expect(strict).toBe('fidelity');
  const raster = await exportInPage(page, '#invoice', { complexScriptFallback: 'raster', strict: true });
  expect(raster.warnings.some((x) => x.code === 'complex-script-rasterized' && x.severity === 'info')).toBe(true);
  expect(raster.warnings.filter((x) => x.severity !== 'info')).toEqual([]);
});
