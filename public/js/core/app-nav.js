/**
 * Shared navigation for control pages. One page list, two presentations.
 *
 *   <script src="/js/core/app-nav.js"></script>
 *     The usual strip across the top of the page.
 *
 *   <script src="/js/core/app-nav.js" data-nav="menu" data-nav-mount=".sel-actions"></script>
 *     A hamburger button appended to the given selector instead, for pages
 *     where a full row of tabs costs more screen than it's worth. Same links,
 *     same active highlight, same event/machine labels — just folded away.
 *
 * Self-contained (styles inline) so it renders identically on every page
 * regardless of that page's own CSS.
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

  const script = document.currentScript;
  const mode   = (script && script.dataset.nav) || 'bar';
  const mount  = (script && script.dataset.navMount) || '';

  const actions = [];   // page-supplied menu entries, see addAction
  let menu = null;      // set once buildMenu has run

  function isActive(href) {
    const here = location.pathname.replace(/index\.html$/, '');
    const target = href.replace(/index\.html$/, '');
    return here === target;
  }

  /** Event name + machine name, fetched once and handed to whoever wants them. */
  function loadLabels(apply) {
    fetch('/api/config')
      .then(r => r.json())
      .then(c => apply(c.eventName || '', (c.machineName || '').trim()))
      .catch(() => {});
  }

  // ── Full-width strip ──────────────────────────────────────────────────
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

    loadLabels((eventName, machineName) => {
      ev.textContent = eventName;
      if (machineName) { machine.textContent = machineName; machine.style.display = ''; }
    });

    document.body.prepend(bar);
  }

  // ── Hamburger ─────────────────────────────────────────────────────────
  function menuStyles() {
    if (document.getElementById('app-nav-menu-styles')) return;
    const s = document.createElement('style');
    s.id = 'app-nav-menu-styles';
    s.textContent = [
      '#app-nav-btn{background:none;border:1px solid rgba(255,255,255,0.14);border-radius:5px;',
      'color:#8888a0;font-size:13px;line-height:1;padding:7px 8px;cursor:pointer;flex-shrink:0;}',
      '#app-nav-btn:hover{border-color:#5b8af5;color:#5b8af5;}',
      '#app-nav-btn[aria-expanded="true"]{border-color:#5b8af5;color:#5b8af5;}',
      '#app-nav-menu{position:fixed;z-index:100000;min-width:190px;max-height:80vh;overflow-y:auto;',
      'background:#1c1c22;border:1px solid rgba(255,255,255,0.16);border-radius:8px;padding:4px;',
      'box-shadow:0 14px 40px rgba(0,0,0,0.6);',
      "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;}",
      '#app-nav-menu a{display:block;padding:8px 11px;border-radius:5px;text-decoration:none;',
      'color:rgba(255,255,255,0.72);font-size:13px;white-space:nowrap;}',
      '#app-nav-menu a:hover{background:rgba(255,255,255,0.09);color:#fff;}',
      '#app-nav-menu a.active{background:rgba(200,16,46,0.42);color:#fff;font-weight:700;}',
      '#app-nav-menu .nav-meta{padding:7px 11px 4px;border-top:1px solid rgba(255,255,255,0.10);',
      'margin-top:4px;font-size:10.5px;color:rgba(255,255,255,0.42);white-space:nowrap;}',
      '#app-nav-menu .nav-machine{display:none;font-weight:800;letter-spacing:1px;',
      'text-transform:uppercase;color:#9cc0ff;font-size:10px;}',
      // Page-supplied actions, above the links and visually separated from them
      // so "go somewhere else" and "do something here" don't blur together.
      '#app-nav-menu .nav-actions:not(:empty){padding-bottom:4px;margin-bottom:4px;',
      'border-bottom:1px solid rgba(255,255,255,0.10);}',
      '#app-nav-menu .nav-action{display:block;width:100%;text-align:left;background:none;',
      'border:0;padding:8px 11px;border-radius:5px;color:rgba(255,255,255,0.72);font-size:13px;',
      "font-family:inherit;white-space:nowrap;cursor:pointer;}",
      '#app-nav-menu .nav-action:hover{background:rgba(255,255,255,0.09);color:#fff;}'
    ].join('');
    document.head.appendChild(s);
  }

  function buildMenu(container) {
    if (!container || document.getElementById('app-nav-btn')) return;
    menuStyles();

    const btn = document.createElement('button');
    btn.id = 'app-nav-btn';
    btn.type = 'button';
    btn.innerHTML = '&#9776;';
    btn.title = 'Go to another page';
    btn.setAttribute('aria-label', 'Navigation menu');
    btn.setAttribute('aria-expanded', 'false');
    btn.setAttribute('aria-haspopup', 'true');

    const panel = document.createElement('div');
    panel.id = 'app-nav-menu';
    panel.style.display = 'none';

    const actionHost = document.createElement('div');
    actionHost.className = 'nav-actions';
    panel.appendChild(actionHost);

    PAGES.forEach(([label, href]) => {
      const a = document.createElement('a');
      a.textContent = label;
      a.href = href;
      if (isActive(href)) a.className = 'active';
      panel.appendChild(a);
    });

    const meta = document.createElement('div');
    meta.className = 'nav-meta';
    const machine = document.createElement('div');
    machine.className = 'nav-machine';
    const ev = document.createElement('div');
    meta.appendChild(machine);
    meta.appendChild(ev);
    panel.appendChild(meta);

    loadLabels((eventName, machineName) => {
      ev.textContent = eventName || 'No event loaded';
      if (machineName) { machine.textContent = machineName; machine.style.display = ''; }
    });

    // Opens downward and right-aligned to the button, clamped to the window —
    // same rule as the select dropdowns, so nothing lands off-screen or up
    // underneath whatever is docked above the browser.
    function place() {
      const r = btn.getBoundingClientRect();
      panel.style.top = (r.bottom + 4) + 'px';
      panel.style.left = 'auto';
      panel.style.right = Math.max(4, window.innerWidth - r.right) + 'px';
      panel.style.maxHeight = Math.max(120, window.innerHeight - r.bottom - 12) + 'px';
    }

    function open() {
      // Labels are read fresh each time, so a toggle can report its current
      // state rather than whatever it said when the menu was built.
      renderActions();
      panel.style.display = '';
      btn.setAttribute('aria-expanded', 'true');
      place();
      window.addEventListener('resize', place);
      window.addEventListener('scroll', place, true);
    }

    function close() {
      panel.style.display = 'none';
      btn.setAttribute('aria-expanded', 'false');
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    }

    function isOpen() { return panel.style.display !== 'none'; }

    btn.addEventListener('click', e => {
      e.stopPropagation();
      isOpen() ? close() : open();
    });

    document.addEventListener('mousedown', e => {
      if (!isOpen()) return;
      if (panel.contains(e.target) || btn.contains(e.target)) return;
      close();
    }, true);

    document.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });

    container.appendChild(btn);
    document.body.appendChild(panel);

    menu = { actionHost, close, render: renderActions };
    renderActions();
  }

  /**
   * Page-supplied menu entries, e.g. a Show/Hide Controls toggle on a page
   * whose chrome the menu has replaced. `label` may be a function so a toggle
   * can name its next action rather than its current state.
   */
  function addAction(label, onClick) {
    actions.push({ label, onClick });
    renderActions();
  }

  function renderActions() {
    if (!menu) return;  // queued until buildMenu runs
    menu.actionHost.textContent = '';
    actions.forEach(({ label, onClick }) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'nav-action';
      b.textContent = typeof label === 'function' ? label() : label;
      b.addEventListener('click', () => { menu.close(); onClick(); });
      menu.actionHost.appendChild(b);
    });
  }

  if (mode === 'menu') {
    // Needs its mount point, which is further down the page than this script.
    const mountMenu = () => {
      const container = mount ? document.querySelector(mount) : null;
      if (container) buildMenu(container);
      else console.warn('[app-nav] menu mount "%s" not found', mount);
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountMenu);
    else mountMenu();
  } else {
    // Unchanged from before the menu existed: render as soon as there's a body
    // to prepend to, rather than waiting for the rest of the page.
    if (document.body) buildBar();
    else document.addEventListener('DOMContentLoaded', buildBar);
  }

  window.AppNav = { PAGES: PAGES, buildMenu: buildMenu, addAction: addAction };
})();
