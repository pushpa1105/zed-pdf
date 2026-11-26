<script setup>
import { computed } from 'vue';

const props = defineProps({ rows: { type: Number, default: 20 } });
const items = computed(() =>
  Array.from({ length: props.rows }, (_, i) => ({ id: `VUE-${String(i + 1).padStart(3, '0')}`, desc: `Scoped line item ${i + 1}`, amount: ((i * 37) % 500) + 10.5 })),
);
const total = computed(() => items.value.reduce((s, i) => s + i.amount, 0).toFixed(2));
</script>

<template>
  <article class="invoice">
    <header>
      <img src="/logo.png" alt="Logo" />
      <h1>INVOICE</h1>
    </header>
    <p class="party"><b>Bill to:</b> Acme Retail Pvt. Ltd.</p>
    <table>
      <thead>
        <tr><th>Item</th><th>Description</th><th class="num">Amount</th></tr>
      </thead>
      <tbody>
        <tr v-for="it in items" :key="it.id">
          <td>{{ it.id }}</td>
          <td>{{ it.desc }}</td>
          <td class="num">{{ it.amount.toFixed(2) }}</td>
        </tr>
      </tbody>
    </table>
    <p class="total">Total NPR {{ total }}</p>
  </article>
</template>

<!-- Scoped styles compile to [data-v-xxxx] attribute selectors; zedpdf copies them with the element. -->
<style scoped>
.invoice { font-family: 'Noto Sans', sans-serif; font-size: 12px; background: #fff; max-width: 760px; padding: 28px; color: #1d2733; }
header { display: flex; justify-content: space-between; align-items: center; border-bottom: 3px solid rgb(10, 120, 60); padding-bottom: 10px; }
header img { width: 160px; }
h1 { color: rgb(10, 120, 60); letter-spacing: 2px; margin: 0; }
table { width: 100%; border-collapse: collapse; margin-top: 16px; }
th { background: rgb(10, 120, 60); color: #fff; text-align: left; padding: 6px 8px; }
td { border-bottom: 1px solid #d5dce4; padding: 6px 8px; }
.num { text-align: right; }
tr { break-inside: avoid; }
.total { font-size: 15px; font-weight: 700; text-align: right; break-inside: avoid; }
</style>
