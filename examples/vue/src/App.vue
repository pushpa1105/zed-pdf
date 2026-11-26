<script setup>
import { ref } from 'vue';
import { pdf } from 'zedpdf';
import InvoiceDoc from './InvoiceDoc.vue';

// A template ref on a plain element gives the HTMLElement directly. For a component ref,
// pass `componentRef.value.$el`. No wrapper is needed.
const invoiceEl = ref(null);
const status = ref('');
const busy = ref(false);

// One handle, every action: download, print, open, preview, share, file, blob.
const invoicePdf = () => pdf(invoiceEl.value, { format: 'A4', margin: '12mm', title: 'Invoice', filename: 'invoice-vue' });

async function download() {
  busy.value = true;
  try {
    const { pageCount, warnings } = await invoicePdf().download();
    status.value = `${pageCount} pages, ${warnings.length} warnings`;
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="toolbar">
    <button id="download" :disabled="busy" @click="download">Download PDF</button>
    <button id="open" @click="invoicePdf().open()">Open</button>
    <button id="print" @click="invoicePdf().print()">Print…</button>
    <output id="status">{{ status }}</output>
  </div>
  <div ref="invoiceEl">
    <InvoiceDoc :rows="60" />
  </div>
</template>

<style>
@font-face { font-family: 'Noto Sans'; src: url('/fonts/NotoSans_400Regular.ttf') format('truetype'); font-weight: 400; }
@font-face { font-family: 'Noto Sans'; src: url('/fonts/NotoSans_700Bold.ttf') format('truetype'); font-weight: 700; }
body { font-family: system-ui, sans-serif; background: #f1f3f6; margin: 0; padding: 24px; }
.toolbar { display: flex; gap: 8px; margin-bottom: 16px; }
</style>
