(function () {
  function isPreviewMode() {
    return new URLSearchParams(window.location.search).get("preview") === "1";
  }

  function coercePreviewPayload(payload) {
    if (!isPreviewMode() || !payload || typeof payload !== "object") return payload;
    const next = JSON.parse(JSON.stringify(payload));
    next.control = { ...(next.control || {}), visible: true, state: "animateIn" };
    const params = new URLSearchParams(window.location.search);
    const template = next.meta?.template;

    if (template === "rankings" && params.get("previewPage")) {
      const page = Math.max(1, Number(params.get("previewPage")) || 1);
      const data = next.data || {};

      if (data.groupedPageMode && Array.isArray(data.groupedPages) && data.groupedPages.length) {
        const pageCount = data.groupedPages.length;
        const safePage = Math.min(page, pageCount);
        data.page = safePage;
        data.pageCount = pageCount;
        data.rows = data.groupedPages[safePage - 1] || [];
        data.rowCount = data.rows.length;
        data.rowsPerPage = data.rows.length || data.rowsPerPage;
      } else if (Array.isArray(data.allRows) && data.allRows.length) {
        const rpp = Math.max(1, Number(data.rowsPerPage) || 8);
        const pageCount = Math.max(1, Math.ceil(data.allRows.length / rpp));
        const safePage = Math.min(page, pageCount);
        const start = (safePage - 1) * rpp;
        data.page = safePage;
        data.pageCount = pageCount;
        data.rows = data.allRows.slice(start, start + rpp);
        data.rowCount = data.rows.length;
      } else if (Array.isArray(data.rows)) {
        data.page = page;
        data.pageCount = Math.max(Number(data.pageCount) || page, page);
      }

      next.data = data;
      next.control.state = "pageChange";
      next.meta.revision = `${next.meta.revision || Date.now()}-preview-page-${next.data.page || page}`;
    }
    return next;
  }

  window.JsonPoller = class JsonPoller {
    constructor({ url, intervalMs = 500, onData, onError }) {
      this.url = url;
      this.intervalMs = intervalMs;
      this.onData = onData;
      this.onError = onError;
      this.timer = null;
      this.running = false;
      this._initialLoaded = false;
    }

    async pollOnce() {
      // WebSocket delivers updates in real time — skip HTTP polling while
      // it's connected. Always do the very first fetch regardless so the
      // graphic has data even if the WS replay arrives before subscribers
      // were registered or carries a duplicate revision.
      if (window.WsListener?.isConnected?.() && this._initialLoaded) return;
      try {
        const cacheBust = Date.now();
        const params = new URLSearchParams(window.location.search);
        const previewGroup = params.get("previewGroup");
        const pollUrl = isPreviewMode() && previewGroup && this.url.includes("/data/starting-order.json")
          ? `/api/preview/starting-order/group/${encodeURIComponent(previewGroup)}`
          : this.url;
        const pollSeparator = pollUrl.includes("?") ? "&" : "?";
        const response = await fetch(`${pollUrl}${pollSeparator}t=${cacheBust}`, {
          cache: "no-store",
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status} loading ${this.url}`);
        }

        const json = coercePreviewPayload(await response.json());
        this._initialLoaded = true;
        if (this.onData) this.onData(json);
      } catch (error) {
        if (this.onError) this.onError(error);
        else console.error(error);
      }
    }

    start() {
      if (this.running) return;
      this.running = true;
      this.pollOnce();
      this.timer = setInterval(() => this.pollOnce(), this.intervalMs);
    }

    stop() {
      this.running = false;
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
    }
  };
})();
