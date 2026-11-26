// Script-tag build (window.ZedPdf). Buttons with data-zedpdf="…" work without any JavaScript:
// they are bound automatically once the page has loaded. Add data-zedpdf-manual to the <script>
// tag to opt out and call ZedPdf.bindActions() yourself.
import * as api from './index.js';
import { bindActions } from './actions.js';

export * from './index.js';

const script = typeof document !== 'undefined' ? (document.currentScript as HTMLScriptElement | null) : null;
if (typeof document !== 'undefined' && !script?.hasAttribute('data-zedpdf-manual')) {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => bindActions(), { once: true });
  else bindActions();
}
void api;
