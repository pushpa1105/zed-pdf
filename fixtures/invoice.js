// Deterministic invoice fixture shared by the demo, tests and comparison scripts.
// renderInvoice(container, { preset, rows, base }) builds the invoice DOM inside `container`.

const PRODUCTS = [
  ['Steel shelving unit', 'Galvanised, 5 tiers, 180 × 90 × 40 cm'],
  ['Office chair', 'Ergonomic mesh back, adjustable lumbar support'],
  ['A4 copy paper', '80 gsm, 500 sheets per ream, carton of 5'],
  ['LED panel light', '40 W, 4000 K neutral white, 60 × 60 cm'],
  ['Thermal printer roll', '80 mm × 70 m, BPA free'],
  ['Wireless keyboard', 'Low-profile, US layout, 2.4 GHz receiver'],
  ['Cable management kit', 'Velcro ties, raceways and adhesive clips'],
  ['Filing cabinet', '4 drawers, lockable, powder-coated grey'],
];

const LONG_DESC =
  'Custom fabrication of a modular warehouse racking system including design consultation, structural load calculations for the mezzanine floor, galvanised uprights and beams, wire mesh decking, row spacers, column guards, end-of-aisle protection barriers, anchor bolts, on-site delivery, professional installation by certified technicians over five working days, load signage, an as-built drawing package, a twelve-month inspection schedule, and staff training on safe loading practices. ';

function money(n) {
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

export const PRESETS = {
  'one-page': { rows: 6 },
  'two-page': { rows: 28 },
  long: { rows: 200 },
  oversized: { rows: 8, oversized: true },
  'missing-image': { rows: 6, missingImage: true },
  bilingual: { rows: 10, bilingual: true },
};

export function renderInvoice(container, opts = {}) {
  const preset = PRESETS[opts.preset ?? 'two-page'] ?? PRESETS['two-page'];
  const rows = opts.rows ?? preset.rows;
  const base = opts.base ?? new URL('./', import.meta.url).href;
  const rand = rng(42);
  const nep = !!preset.bilingual;
  const items = [];
  for (let i = 0; i < rows; i++) {
    const [name, spec] = PRODUCTS[i % PRODUCTS.length];
    const qty = 1 + Math.floor(rand() * 12);
    const price = Math.round((5 + rand() * 480) * 100) / 100;
    const disc = i % 7 === 3 ? 10 : 0;
    items.push({ id: `ITEM-${String(i + 1).padStart(4, '0')}`, name, spec, qty, price, disc, amount: qty * price * (1 - disc / 100) });
  }
  const subtotal = items.reduce((s, it) => s + it.qty * it.price, 0);
  const discount = items.reduce((s, it) => s + (it.qty * it.price * it.disc) / 100, 0);
  const taxable = subtotal - discount;
  const tax = taxable * 0.13;
  const grand = taxable + tax;

  const logo = preset.missingImage ? `${base}assets/does-not-exist.png` : `${base}assets/logo.png`;
  const rowsHtml = items
    .map((it, i) => {
      let desc = `<b>${it.name}</b><br><span class="sku">${it.spec}</span>`;
      if (i === 1) desc = `<img class="thumb" src="${base}assets/product.jpg" alt=""><b>${it.name}</b> <i>(refurbished)</i><br><span class="sku">${it.spec}</span>`;
      if (i === 2) desc += ` <span class="badge">IN STOCK</span>`;
      if (i === 4) desc = `<b>${it.name}</b> — <i>priority</i> <b>express</b> delivery with <u>signature</u> on receipt<br>Line two after an explicit break<br><span class="sku">${it.spec}</span>`;
      if (preset.oversized && i === 3) desc = `<b>Warehouse racking project</b><br>${LONG_DESC.repeat(12)}`;
      if (nep && i % 3 === 0) desc += `<br><span class="devanagari">गोदाम सामग्री — क्षेत्रीय वितरण, श्रीमती लक्ष्मी श्रेष्ठ</span>`;
      return `<tr data-id="${it.id}">
        <td class="id">${it.id}</td>
        <td class="desc">${desc}</td>
        <td class="num">${it.qty}</td>
        <td class="num">${money(it.price)}</td>
        <td class="num">${it.disc ? it.disc + '%' : '—'}</td>
        <td class="num">${money(it.amount)}</td>
      </tr>`;
    })
    .join('');

  const customer = nep ? 'राम बहादुर थापा (Ram Bahadur Thapa)' : 'Acme Retail Pvt. Ltd.';
  container.innerHTML = `
  <div class="invoice" id="invoice" lang="${nep ? 'ne' : 'en'}">
    <div class="head">
      <div class="brand">
        <img src="${logo}" alt="Himal Trading Co. logo">
        <p>Himal Trading Co. · Lazimpat, Kathmandu 44600 · VAT 600123456</p>
      </div>
      <div class="meta">
        <h1>INVOICE</h1>
        <table>
          <tr><td>Invoice no.</td><td><b>INV-2026-0042</b></td></tr>
          <tr><td>Issue date</td><td>25 Nov 2026</td></tr>
          <tr><td>Due date</td><td>25 Dec 2026</td></tr>
          <tr><td>Status</td><td><img class="stamp" src="${base}assets/paid-stamp.svg" alt="paid"></td></tr>
        </table>
      </div>
    </div>
    <div class="screen-only" style="padding:6px;background:#fee;color:#900">SCREEN-ONLY BANNER (hidden in print/export)</div>
    <div class="parties">
      <div class="party"><h3>${nep ? 'बिल गर्ने ठेगाना · Bill to' : 'Bill to'}</h3><p><b>${customer}</b><br>${nep ? 'वडा नं. ४, पोखरा, कास्की' : '221B Market Road'}<br>${nep ? 'Pokhara, Gandaki 33700' : 'Lalitpur 44700, Nepal'}<br>PAN 301234567</p></div>
      <div class="party"><h3>${nep ? 'ढुवानी ठेगाना · Ship to' : 'Ship to'}</h3><p><b>${nep ? 'श्रीमती सीता गुरुङ (Sita Gurung)' : 'Acme Retail Warehouse'}</b><br>Plot 17, Industrial Estate<br>Balaju, Kathmandu 44611<br>Contact: +977 1 4350000</p></div>
    </div>
    <table class="items">
      <thead><tr><th>ID</th><th>Description</th><th class="num">Qty</th><th class="num">Unit price</th><th class="num">Disc.</th><th class="num">Amount (NPR)</th></tr></thead>
      <tbody>${rowsHtml}</tbody>
    </table>
    <table class="totals">
      <tr><td>Subtotal</td><td>${money(subtotal)}</td></tr>
      <tr><td>Discount</td><td>−${money(discount)}</td></tr>
      <tr><td>Taxable amount</td><td>${money(taxable)}</td></tr>
      <tr><td>VAT 13%</td><td>${money(tax)}</td></tr>
      <tr class="grand"><td>GRAND TOTAL NPR</td><td>${money(grand)}</td></tr>
    </table>
    <div class="terms">
      <h4>Payment terms</h4>
      <ul>
        <li>Payment due within 30 days by bank transfer to Himal Bank, A/C 0012-3456-7890.</li>
        <li>Late payments accrue 1.5% interest per month; quote <b>INV-2026-0042</b> as reference.</li>
        <li>Goods remain the property of Himal Trading Co. until paid in full. Prices in NPR incl. € / $ / £ / ₹ conversions on request.</li>
      </ul>
    </div>
    <p class="note">Thank you for your business! — “Quality you can count on.” Questions? accounts@example.com</p>
  </div>`;
  return { items, grand: money(grand), element: container.querySelector('#invoice') };
}
