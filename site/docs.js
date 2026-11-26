// Docs page: tabbed code, active section in the sidebar, "on this page" index, mobile menu.
import { initTabs } from './ui.js';
import { VERSION } from './lib/zedpdf.js';

initTabs();
document.getElementById('ver').textContent = `v${VERSION}`;

const sidebar = document.getElementById('sidebar');
document.getElementById('menu').addEventListener('click', () => sidebar.classList.toggle('open'));
sidebar.addEventListener('click', (e) => e.target.closest('a') && sidebar.classList.remove('open'));

const sections = [...document.querySelectorAll('.prose > section')];
const links = new Map([...sidebar.querySelectorAll('a')].map((a) => [a.getAttribute('href').slice(1), a]));
const toc = document.getElementById('toc');

function setActive(section) {
  for (const a of links.values()) a.classList.toggle('active', a === links.get(section.id));
  toc.replaceChildren(
    ...[...section.querySelectorAll('h3[id]')].map((h) => {
      const a = document.createElement('a');
      a.href = `#${h.id}`;
      a.textContent = h.textContent;
      return a;
    }),
  );
}

// The active section is the last one whose top has scrolled past 30% of the viewport.
let ticking = false;
function onScroll() {
  ticking = false;
  const line = window.innerHeight * 0.3;
  let current = sections[0];
  for (const s of sections) if (s.getBoundingClientRect().top <= line) current = s;
  if (current !== onScroll.last) {
    onScroll.last = current;
    setActive(current);
  }
  const heads = toc.querySelectorAll('a');
  let h = null;
  for (const a of heads) {
    const el = document.getElementById(a.getAttribute('href').slice(1));
    if (el && el.getBoundingClientRect().top <= line) h = a;
  }
  for (const a of heads) a.classList.toggle('active', a === h);
}
window.addEventListener('scroll', () => {
  if (!ticking) {
    ticking = true;
    requestAnimationFrame(onScroll);
  }
});
onScroll();
document.documentElement.dataset.ready = '1';
