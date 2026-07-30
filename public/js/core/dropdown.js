/**
 * Downward-only dropdowns.
 *
 * A native <select> popup opens wherever the browser thinks it fits, which on a
 * vMix machine means upward — straight under the Stream Deck controller window
 * that sits over the top of the screen, putting the first entries of a long
 * category list out of reach.
 *
 * This replaces the popup (not the <select>) with our own list that always
 * opens downward and scrolls. The <select> stays in the DOM and stays the
 * source of truth: options are read from it each time the list opens, and
 * choosing one sets `select.value` and fires `change`, so every existing
 * `onchange=` handler and `select.value = x` assignment keeps working as-is.
 *
 * Applies to every <select> on the page. Opt out with `data-native-select`.
 */
(function () {
  'use strict';

  if (window.__downwardDropdowns) return;
  window.__downwardDropdowns = true;

  var GAP = 4;           // breathing room between the select and the list
  var EDGE = 8;          // keep the list this far off the bottom of the window
  var MIN_HEIGHT = 120;  // never squash it smaller than this, scroll instead

  var open = null;       // { select, pop, onScroll }

  function css() {
    if (document.getElementById('dd-styles')) return;
    var s = document.createElement('style');
    s.id = 'dd-styles';
    s.textContent = [
      '.dd-pop{position:fixed;z-index:99999;overflow-y:auto;overscroll-behavior:contain;',
      'background:#2c2c34;border:1px solid rgba(255,255,255,0.16);border-radius:8px;',
      'box-shadow:0 12px 34px rgba(0,0,0,0.55);padding:4px;',
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;',
      '-webkit-overflow-scrolling:touch;}',
      '.dd-opt{padding:8px 10px;border-radius:5px;color:#f0f0f2;font-size:13px;line-height:1.3;',
      'cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.dd-opt:hover{background:rgba(255,255,255,0.10);}',
      '.dd-opt.dd-sel{background:rgba(91,138,245,0.32);color:#fff;font-weight:600;}',
      '.dd-opt.dd-dis{opacity:.4;cursor:default;}',
      '.dd-opt.dd-dis:hover{background:none;}',
      '.dd-group{padding:8px 10px 3px;font-size:10px;font-weight:800;letter-spacing:1px;',
      'text-transform:uppercase;color:#8888a0;}',
      '.dd-pop::-webkit-scrollbar{width:10px;}',
      '.dd-pop::-webkit-scrollbar-track{background:transparent;}',
      '.dd-pop::-webkit-scrollbar-thumb{background:rgba(255,255,255,0.22);border-radius:5px;}'
    ].join('');
    document.head.appendChild(s);
  }

  function close() {
    if (!open) return;
    var o = open;
    open = null;
    if (o.pop.parentNode) o.pop.parentNode.removeChild(o.pop);
    window.removeEventListener('scroll', o.onScroll, true);
    window.removeEventListener('resize', o.onScroll);
  }

  /** Position below the select, clamped to the window, scrolling if it can't fit. */
  function place(select, pop) {
    var r = select.getBoundingClientRect();
    pop.style.left = r.left + 'px';
    pop.style.width = r.width + 'px';
    pop.style.top = (r.bottom + GAP) + 'px';
    pop.style.maxHeight = 'none';

    var room = window.innerHeight - r.bottom - GAP - EDGE;
    var needed = pop.scrollHeight;

    if (needed <= room) return;

    if (room >= MIN_HEIGHT) {
      // Enough room to be useful — scroll inside it.
      pop.style.maxHeight = room + 'px';
      return;
    }

    // The select is so near the bottom that a downward list would be a sliver.
    // Still grow downward from the select, but lift the whole list up the
    // minimum amount needed — never above the select's own top edge, so it
    // can't end up behind something docked at the top of the screen.
    var height = Math.min(needed, window.innerHeight - r.top - EDGE);
    pop.style.maxHeight = height + 'px';
    pop.style.top = Math.max(r.top, window.innerHeight - EDGE - height) + 'px';
  }

  function build(select) {
    var pop = document.createElement('div');
    pop.className = 'dd-pop';
    pop.setAttribute('role', 'listbox');

    var selected = null;

    Array.prototype.forEach.call(select.children, function (child) {
      if (child.tagName === 'OPTGROUP') {
        var label = document.createElement('div');
        label.className = 'dd-group';
        label.textContent = child.label || '';
        pop.appendChild(label);
        Array.prototype.forEach.call(child.children, function (opt) {
          var row = optionRow(select, opt, pop);
          if (row && row.classList.contains('dd-sel')) selected = row;
        });
      } else if (child.tagName === 'OPTION') {
        var row = optionRow(select, child, pop);
        if (row && row.classList.contains('dd-sel')) selected = row;
      }
    });

    pop._selectedRow = selected;
    return pop;
  }

  function optionRow(select, opt, pop) {
    if (opt.hidden) return null;

    var row = document.createElement('div');
    row.className = 'dd-opt';
    row.setAttribute('role', 'option');
    row.textContent = opt.textContent;
    row.title = opt.textContent;

    if (opt.disabled) {
      row.classList.add('dd-dis');
    } else {
      if (opt.selected) {
        row.classList.add('dd-sel');
        row.setAttribute('aria-selected', 'true');
      }
      row.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        close();
        if (select.value === opt.value && !opt.hasAttribute('data-always-fire')) {
          // Re-picking what's already active: don't fire change, matching how a
          // native select behaves. Handlers here often re-fetch from the API.
          select.focus();
          return;
        }
        select.value = opt.value;
        select.dispatchEvent(new Event('input', { bubbles: true }));
        select.dispatchEvent(new Event('change', { bubbles: true }));
        select.focus();
      });
    }

    pop.appendChild(row);
    return row;
  }

  function show(select) {
    css();
    close();

    if (select.disabled) return;
    if (!select.options || select.options.length === 0) return;

    var pop = build(select);
    document.body.appendChild(pop);
    place(select, pop);

    var onScroll = function () {
      if (open && open.select === select) place(select, pop);
    };
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);

    open = { select: select, pop: pop, onScroll: onScroll };

    if (pop._selectedRow) pop._selectedRow.scrollIntoView({ block: 'nearest' });
    select.focus();
  }

  function attach(select) {
    if (select.dataset.ddBound === '1') return;
    if (select.hasAttribute('data-native-select')) return;
    if (select.multiple || select.size > 1) return;
    select.dataset.ddBound = '1';

    // Suppress the native popup. mousedown is what opens it, so cancelling
    // there is what keeps the browser from choosing its own direction.
    select.addEventListener('mousedown', function (e) {
      if (e.button !== 0) return;
      if (select.disabled) return;
      e.preventDefault();
      if (open && open.select === select) { close(); return; }
      show(select);
    });

    // Keyboard: let arrow keys work natively on the closed select (the browser
    // steps through options without a popup), but open our list on the keys
    // that would normally pop it open.
    select.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ' || (e.altKey && e.key === 'ArrowDown')) {
        e.preventDefault();
        if (open && open.select === select) close(); else show(select);
      } else if (e.key === 'Escape' && open) {
        close();
      }
    });

    select.addEventListener('blur', function () {
      // Delay so a click landing on an option still registers.
      setTimeout(function () {
        if (open && open.select === select && document.activeElement !== select) close();
      }, 150);
    });
  }

  function scan(root) {
    var list = (root || document).querySelectorAll ? (root || document).querySelectorAll('select') : [];
    Array.prototype.forEach.call(list, attach);
  }

  document.addEventListener('mousedown', function (e) {
    if (!open) return;
    if (open.pop.contains(e.target) || e.target === open.select) return;
    close();
  }, true);

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') close();
  });

  // Selects get built at runtime here (categories arrive from the API), so keep
  // watching rather than binding once.
  function watch() {
    scan(document);
    if (typeof MutationObserver !== 'function') return;
    new MutationObserver(function (records) {
      for (var i = 0; i < records.length; i++) {
        var added = records[i].addedNodes;
        for (var j = 0; j < added.length; j++) {
          var node = added[j];
          if (node.nodeType !== 1) continue;
          if (node.tagName === 'SELECT') attach(node);
          else scan(node);
        }
      }
    }).observe(document.documentElement, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', watch);
  } else {
    watch();
  }

  window.DownwardDropdowns = { attach: attach, scan: scan, close: close };
})();
