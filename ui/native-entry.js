/* Host-injected classic script, pinned to native OpenDesign page anchors.
 * Host must verify the compiled GUI fingerprint before serving /paseo/entry.js.
 * No provider authentication or pairing data passes through this entry.
 */
(() => {
  "use strict";
  const pluginURL = "/api/plugins/woowtech-paseo";
  const source = "github:WOOWTECH/opendesign-paseo-plugin";
  const selectors = '[data-testid="plugins-card-woowtech-paseo"], .integrations-view__hero';
  const entries = new Map();
  let stopped = false, scanTimer = null, checking = null, installing = false;
  let state = "unknown", checks = 0, controller = null;
  const ownsSource = value => typeof value === "string" &&
    /^(?:github:WOOWTECH\/opendesign-paseo-plugin(?:@[A-Za-z0-9._-]+)?(?:\/plugin)?|https:\/\/github\.com\/WOOWTECH\/opendesign-paseo-plugin(?:\.git)?\/?(?:tree\/[A-Za-z0-9._-]+\/plugin)?)$/.test(value);
  function render(entry) {
    const message = entry.querySelector("p"), link = entry.querySelector("a"), button = entry.querySelector("button");
    message.textContent = {
      installed: "管理 Paseo 服務、帳號、模型與官方 App 連線。",
      absent: "安裝原生 Paseo 外掛後，開啟受保護的設定頁。",
      unknown: "正在確認 Paseo 外掛…",
      error: "無法確認外掛。請重新登入或在 Plugins 確認來源。",
      foreign: "同名外掛的來源不符，請在 Plugins 確認來源。",
      installing: "正在安裝原生 Paseo 外掛；完成後可前往設定。",
    }[installing ? "installing" : state];
    link.hidden = state !== "installed" || installing;
    button.hidden = state !== "absent" || installing;
    button.disabled = installing;
    entry.setAttribute("aria-busy", installing ? "true" : "false");
  }
  function update() { for (const entry of entries.values()) render(entry); }
  async function check() {
    if (checking || stopped || checks >= 20 || installing) return checking;
    checks += 1;
    controller = new AbortController();
    const issued = controller;
    const timer = setTimeout(() => issued.abort(), 15000);
    checking = (async () => {
      try {
        const response = await fetch(pluginURL, { credentials: "same-origin", cache: "no-store", redirect: "error", headers: { Accept: "application/json" }, signal: issued.signal });
        if (stopped) return;
        if (response.status === 404) state = "absent";
        else if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) state = "error";
        else {
          const dto = await response.json();
          if (stopped) return;
          state = dto?.id === "woowtech-paseo" && dto?.manifest?.name === "woowtech-paseo" && ownsSource(dto.source) ? "installed" : "foreign";
        }
      } catch { if (!stopped) state = "error"; }
      finally { clearTimeout(timer); checking = null; if (controller === issued) controller = null; if (!stopped) update(); }
    })();
    return checking;
  }
  async function install() {
    if (installing || stopped || state !== "absent") return;
    installing = true; update();
    const issued = new AbortController();
    controller = issued;
    const timer = setTimeout(() => issued.abort(), 180000);
    try {
      // Native OD installer handles trust/workspace policy; no trust override.
      const response = await fetch("/api/plugins/install", {
        method: "POST", credentials: "same-origin", cache: "no-store", redirect: "error",
        headers: { Accept: "text/event-stream, application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ source }), signal: issued.signal,
      });
      if (!response.ok) throw new Error("INSTALL_FAILED");
      // Consume native SSE to completion without storing or rendering raw logs.
      if (response.body) {
        const reader = response.body.getReader();
        try {
          let bytes = 0;
          while (!stopped) {
            const part = await reader.read();
            if (part.done) break;
            bytes += part.value.byteLength;
            if (bytes > 1048576) throw new Error("OUTPUT_LIMIT");
          }
        } finally { await reader.cancel(); }
      }
      if (stopped) return;
      installing = false; state = "unknown"; checks = 0;
      await check(); // HTTP 200/SSE EOF alone does not prove installation.
      if (state !== "installed") state = "error";
    } catch { if (!stopped) state = "error"; }
    finally { clearTimeout(timer); if (controller === issued) controller = null; installing = false; if (!stopped) update(); }
  }
  function create() {
    const entry = document.createElement("aside");
    entry.className = "paseo-native-entry";
    entry.setAttribute("aria-label", "Paseo 整合設定");
    entry.setAttribute("data-paseo-entry", "woowtech-paseo");
    const copy = document.createElement("div");
    const title = document.createElement("h2"); title.textContent = "Paseo";
    const message = document.createElement("p");
    copy.appendChild(title); copy.appendChild(message);
    const link = document.createElement("a");
    link.setAttribute("href", "/paseo/setup"); link.textContent = "安裝與連線設定"; link.hidden = true;
    const button = document.createElement("button");
    button.type = "button"; button.textContent = "安裝 Paseo 外掛"; button.hidden = true;
    button.addEventListener("click", () => { void install(); });
    entry.appendChild(copy); entry.appendChild(link); entry.appendChild(button); render(entry);
    return entry;
  }
  function scan() {
    scanTimer = null;
    if (stopped) return;
    for (const [target, entry] of entries) {
      if (!target.isConnected || !entry.isConnected) { entry.remove(); entries.delete(target); }
    }
    const targets = [...document.querySelectorAll(selectors)].slice(0, 16);
    for (const target of targets) {
      if (entries.has(target)) continue;
      // Restrict the hero anchor to its pinned native section.
      if (target.matches(".integrations-view__hero") && !target.closest('section.integrations-view[aria-labelledby="integrations-title"]')) continue;
      const entry = create();
      target.insertAdjacentElement("afterend", entry);
      entries.set(target, entry);
    }
    if (entries.size && state === "unknown") void check();
  }
  function schedule() {
    if (!stopped && scanTimer === null) scanTimer = setTimeout(scan, 200);
  }
  const observer = new MutationObserver(records => {
    if (records.some(record => !record.target.closest?.(".paseo-native-entry"))) schedule();
  });
  const changed = () => {
    if (!installing) { state = "unknown"; checks = 0; if (entries.size) void check(); }
    schedule();
  };
  window.addEventListener("open-design:plugins-changed", changed);
  window.addEventListener("pagehide", () => {
    stopped = true; observer.disconnect(); clearTimeout(scanTimer); scanTimer = null;
    controller?.abort();
    window.removeEventListener("open-design:plugins-changed", changed);
  });
  window.addEventListener("pageshow", event => {
    if (event.persisted) {
      stopped = false; state = "unknown"; checks = 0;
      window.addEventListener("open-design:plugins-changed", changed);
      observer.observe(document.body, { childList: true, subtree: true });
      schedule();
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
  scan();
})();
