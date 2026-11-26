// Generates the deterministic fixture images with headless Chromium canvas:
//  - logo.png: transparent PNG (RGBA, antialiased edges, semi-transparent ring)
//  - product.jpg: a photographic-style JPEG (to verify JPEG passthrough without recompression)
//  - stamp.svg is hand-written below.
import { chromium } from '@playwright/test';
import { writeFileSync } from 'node:fs';

const out = new URL('../fixtures/assets/', import.meta.url);
const browser = await chromium.launch();
const page = await browser.newPage();
const data = await page.evaluate(() => {
  const logo = document.createElement('canvas');
  logo.width = 480;
  logo.height = 160;
  const c = logo.getContext('2d');
  // mountain mark
  c.fillStyle = 'rgba(16, 94, 166, 1)';
  c.beginPath();
  c.moveTo(20, 140); c.lineTo(80, 40); c.lineTo(110, 85); c.lineTo(130, 60); c.lineTo(180, 140); c.closePath();
  c.fill();
  c.fillStyle = 'rgba(255,255,255,0.9)';
  c.beginPath();
  c.moveTo(80, 40); c.lineTo(66, 63); c.lineTo(80, 58); c.lineTo(92, 66); c.closePath();
  c.fill();
  c.strokeStyle = 'rgba(232, 93, 4, 0.55)';
  c.lineWidth = 10;
  c.beginPath(); c.arc(100, 95, 80, Math.PI * 1.05, Math.PI * 1.95); c.stroke();
  c.fillStyle = '#12355b';
  c.font = 'bold 58px sans-serif';
  c.fillText('HIMAL', 200, 100);
  c.fillStyle = 'rgba(18,53,91,0.6)';
  c.font = '24px sans-serif';
  c.fillText('TRADING CO.', 204, 135);

  const photo = document.createElement('canvas');
  photo.width = 400;
  photo.height = 300;
  const p = photo.getContext('2d');
  const g = p.createLinearGradient(0, 0, 400, 300);
  g.addColorStop(0, '#f4a261'); g.addColorStop(0.5, '#e76f51'); g.addColorStop(1, '#264653');
  p.fillStyle = g; p.fillRect(0, 0, 400, 300);
  for (let i = 0; i < 40; i++) {
    p.fillStyle = `hsla(${(i * 37) % 360}, 60%, 60%, 0.35)`;
    p.beginPath(); p.arc((i * 97) % 400, (i * 53) % 300, 20 + (i % 5) * 8, 0, Math.PI * 2); p.fill();
  }
  p.fillStyle = 'white'; p.font = 'bold 40px sans-serif'; p.fillText('PRODUCT', 110, 160);
  return { logo: logo.toDataURL('image/png'), photo: photo.toDataURL('image/jpeg', 0.85) };
});
writeFileSync(new URL('logo.png', out), Buffer.from(data.logo.split(',')[1], 'base64'));
writeFileSync(new URL('product.jpg', out), Buffer.from(data.photo.split(',')[1], 'base64'));
writeFileSync(
  new URL('paid-stamp.svg', out),
  `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="48" viewBox="0 0 120 48"><rect x="3" y="3" width="114" height="42" rx="8" fill="none" stroke="#2a9d8f" stroke-width="4"/><text x="60" y="32" font-family="sans-serif" font-size="22" font-weight="bold" fill="#2a9d8f" text-anchor="middle">PAID</text></svg>\n`,
);
await browser.close();
console.log('assets written');
