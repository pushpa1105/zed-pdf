import { useRef, useState } from 'react';
import { pdf } from 'zedpdf';

// The theme lives on an ANCESTOR of the exported element (class + CSS custom properties + font).
// zedpdf rebuilds the ancestor chain in its export surface, so the invoice keeps its theme.
function ThemeProvider({ theme, children }) {
  return <div className={`theme theme-${theme}`}>{children}</div>;
}

function Invoice({ rows }) {
  const items = Array.from({ length: rows }, (_, i) => ({ id: `REACT-${String(i + 1).padStart(3, '0')}`, amount: ((i * 37) % 500) + 10.5 }));
  const total = items.reduce((s, i) => s + i.amount, 0).toFixed(2);
  return (
    <>
      <header>
        <img src="./logo.png" alt="Logo" />
        <h1>INVOICE</h1>
      </header>
      <p><b>Bill to:</b> Acme Retail Pvt. Ltd.</p>
      <table>
        <thead>
          <tr><th>Item</th><th>Description</th><th className="num">Amount</th></tr>
        </thead>
        <tbody>
          {items.map((it, i) => (
            <tr key={it.id}><td>{it.id}</td><td>Themed line item {i + 1}</td><td className="num">{it.amount.toFixed(2)}</td></tr>
          ))}
        </tbody>
      </table>
      <p className="total">Total NPR {total}</p>
    </>
  );
}

export default function App() {
  const ref = useRef(null); // useRef gives the HTMLElement directly: no wrapper needed
  const [status, setStatus] = useState('');
  // One handle, every action: download, print, open, preview, share, file, blob.
  const invoicePdf = () => pdf(ref.current, { format: 'A4', margin: '12mm', title: 'Invoice', filename: 'invoice-react' });
  const download = async () => {
    const { pageCount, warnings } = await invoicePdf().download();
    setStatus(`${pageCount} pages, ${warnings.length} warnings`);
  };
  return (
    <ThemeProvider theme="ocean">
      <div className="toolbar">
        <button id="download" onClick={download}>Download PDF</button>
        <button id="open" onClick={() => invoicePdf().open()}>Open</button>
        <button id="print" onClick={() => invoicePdf().print()}>Print…</button>
        <output id="status">{status}</output>
      </div>
      <article className="invoice" ref={ref}>
        <Invoice rows={60} />
      </article>
    </ThemeProvider>
  );
}
