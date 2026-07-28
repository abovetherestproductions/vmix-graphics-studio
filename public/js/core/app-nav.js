/**
 * Shared navigation strip for control pages.
 * Include with: <script src="/js/core/app-nav.js"></script>
 * Self-contained (styles inline) so it renders identically on every page
 * regardless of that page's own CSS. Highlights the current page and shows
 * the configured event name on the right.
 */
(function () {
  const PAGES = [
    ['Operator',           '/operator/'],
    ['Event & Skater Selector', '/operator/sc-api.html'],
    ['Preview Wall',       '/preview/'],
    ['Production Control', '/production-control/'],
    ['Messages',           '/messages/'],
    ['Interview',          '/operator/interview.html'],
    ['Clocks',             '/operator/clocks.html'],
    ['Event Workbooks',    '/operator/workbooks.html'],
    ['Button Commands',    '/operator/commands.html'],
    ['Export Stills',      '/operator/export.html'],
    // Manual Skaters hidden for now — not needed while every event runs on
    // the Skate Canada API. Re-add here if that changes.
  ];

  function isActive(href) {
    const here = location.pathname.replace(/index\.html$/, '');
    const target = href.replace(/index\.html$/, '');
    return here === target;
  }

  function buildBar() {
    if (document.getElementById('app-nav')) return;
    const bar = document.createElement('nav');
    bar.id = 'app-nav';
    bar.style.cssText =
      'position:sticky;top:0;z-index:10000;display:flex;align-items:center;gap:2px;' +
      'padding:6px 12px;background:#101014;border-bottom:1px solid rgba(255,255,255,0.10);' +
      "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:12px;" +
      'overflow-x:auto;scrollbar-width:none;';

    PAGES.forEach(([label, href]) => {
      const a = document.createElement('a');
      a.textContent = label;
      a.href = href;
      const active = isActive(href);
      a.style.cssText =
        'padding:4px 10px;border-radius:6px;text-decoration:none;white-space:nowrap;' +
        (active
          ? 'color:#fff;background:rgba(200,16,46,0.4);font-weight:700;'
          : 'color:rgba(255,255,255,0.62);');
      if (!active) {
        a.onmouseenter = () => { a.style.color = '#fff'; a.style.background = 'rgba(255,255,255,0.07)'; };
        a.onmouseleave = () => { a.style.color = 'rgba(255,255,255,0.62)'; a.style.background = ''; };
      }
      bar.appendChild(a);
    });

    const spacer = document.createElement('span');
    spacer.style.flex = '1';
    bar.appendChild(spacer);

    const machine = document.createElement('span');
    machine.style.cssText = 'display:none;font-size:10px;font-weight:800;letter-spacing:1px;text-transform:uppercase;padding:3px 9px;border-radius:11px;background:rgba(91,138,245,0.22);color:#9cc0ff;white-space:nowrap;margin-right:10px;';
    bar.appendChild(machine);

    const ev = document.createElement('span');
    ev.style.cssText = 'color:rgba(255,255,255,0.45);white-space:nowrap;font-size:11px;';
    bar.appendChild(ev);

    fetch('/api/config')
      .then(r => r.json())
      .then(c => {
        ev.textContent = c.eventName || '';
        const m = (c.machineName || '').trim();
        if (m) { machine.textContent = m; machine.style.display = ''; }
      })
      .catch(() => {});

    document.body.prepend(bar);
  }

  if (document.body) buildBar();
  else document.addEventListener('DOMContentLoaded', buildBar);
})();
