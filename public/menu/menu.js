(function () {
  const graphics = [
    ['Starting Order', '/graphics/starting-order/'],
    ['Scoring Display', '/graphics/scoring/'],
    ['Rank 6 Context', '/graphics/standings/'],
    ['Officials', '/graphics/officials/'],
    ['Elements Tracker', '/graphics/elements/'],
    ['Final Rankings', '/graphics/rankings/'],
    ['Messages', '/graphics/messages/'],
    ['Skater Name Bar', '/graphics/manual-skater/'],
    ['Interview', '/graphics/interview/'],
  ];

  const pages = [
    ['Operator', '/operator/'],
    ['Preview Wall', '/preview/'],
    ['Messages Control', '/messages/'],
    ['Manual Skater Control', '/manual-skaters/'],
    ['Interview Control', '/operator/interview.html'],
    ['Clocks Control', '/operator/clocks.html'],
    ['Production Control', '/production-control/'],
  ];

  const baseInput = document.getElementById('base-url');
  const graphicsList = document.getElementById('graphics-list');
  const pagesList = document.getElementById('pages-list');
  const toast = document.getElementById('toast');

  function currentOrigin() {
    return window.location.origin;
  }

  function cleanBaseUrl(value) {
    return String(value || currentOrigin()).trim().replace(/\/+$/, '');
  }

  function makeUrl(path) {
    return `${cleanBaseUrl(baseInput.value)}${path}`;
  }

  function renderList(target, items) {
    target.innerHTML = '';
    items.forEach(([title, path]) => {
      const url = makeUrl(path);
      const card = document.createElement('article');
      card.className = 'url-card';
      card.innerHTML = `
        <div class="url-card-header">
          <div>
            <div class="url-title">${escapeHtml(title)}</div>
            <div class="url-path">${escapeHtml(path)}</div>
          </div>
          <button type="button">Copy</button>
        </div>
        <div class="url-value">${escapeHtml(url)}</div>
      `;
      card.querySelector('button').addEventListener('click', () => copyText(url, `${title} URL copied`));
      target.appendChild(card);
    });
  }

  function render() {
    renderList(graphicsList, graphics);
    renderList(pagesList, pages);
  }

  async function copyText(text, message) {
    try {
      await navigator.clipboard.writeText(text);
      showToast(message);
    } catch {
      showToast('Copy failed. Select the URL manually.');
    }
  }

  function showToast(message) {
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => toast.classList.remove('show'), 1800);
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[ch]));
  }

  baseInput.value = currentOrigin();
  baseInput.addEventListener('input', render);
  document.getElementById('reset-base').addEventListener('click', () => {
    baseInput.value = currentOrigin();
    render();
  });
  document.getElementById('copy-all').addEventListener('click', () => {
    const text = graphics.map(([title, path]) => `${title}: ${makeUrl(path)}`).join('\n');
    copyText(text, 'All graphic URLs copied');
  });

  render();
})();
