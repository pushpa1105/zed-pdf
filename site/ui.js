// Shared UI behaviour for the site: tabbed code blocks.
export function initTabs(root = document) {
  for (const box of root.querySelectorAll('[data-tabs]')) {
    const tabs = box.querySelectorAll(':scope > .tabs [role=tab]');
    for (const tab of tabs) {
      tab.addEventListener('click', () => {
        for (const t of tabs) t.setAttribute('aria-selected', String(t === tab));
        for (const pane of box.querySelectorAll(':scope > [data-pane]')) pane.hidden = pane.dataset.pane !== tab.dataset.pane;
      });
    }
  }
}
