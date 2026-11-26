// Changelog page: copy buttons, mobile release list, active release in the sidebar.
import { initTabs } from './ui.js';

initTabs();

const sidebar = document.getElementById('sidebar');
document.getElementById('menu').addEventListener('click', () => sidebar.classList.toggle('open'));
sidebar.addEventListener('click', (e) => e.target.closest('a') && sidebar.classList.remove('open'));

const releases = [...document.querySelectorAll('.cl-release')];
const links = [...sidebar.querySelectorAll('a[href^="#"]')];

let ticking = false;
function onScroll() {
  ticking = false;
  const line = window.innerHeight * 0.3;
  let current = releases[0];
  for (const s of releases) if (s.getBoundingClientRect().top <= line) current = s;
  for (const a of links) a.classList.toggle('active', !!current && a.getAttribute('href') === `#${current.id}`);
}
window.addEventListener('scroll', () => {
  if (!ticking) {
    ticking = true;
    requestAnimationFrame(onScroll);
  }
});
onScroll();
document.documentElement.dataset.ready = '1';
