/* Protected, same-origin bridge UI. The host owns authentication and sanitized DTOs. */
(() => {
  "use strict";
  const endpoint = "/api/paseo-bridge";
  const providers = ["claude", "codex", "pi"];
  const names = { claude: "Claude Code", codex: "Codex", pi: "Pi" };
  const phaseLabels = {
    absent: "尚未安裝", not_installed: "尚未安裝", installing: "正在安裝",
    starting: "正在啟動", ready: "服務已就緒", running: "服務運作中",
    stopped: "服務已停止", disabled: "服務已停止", stopping: "正在停止",
    error: "需要處理", failed: "需要處理", degraded: "連線待確認", restart_required: "需要重新啟動",
  };
  const diagnostics = {
    PROVIDER_AUTH_REQUIRED: "請先完成官方登入。",
    PROVIDER_QUOTA_EXHAUSTED: "服務商額度不足，或模型的輸出上限超過可用額度。請在服務商確認額度，或在原生模型設定降低輸出上限後重試。",
    PROVIDER_TURN_FAILED: "服務商未能完成這輪回覆。請確認所選模型、帳號額度與原生設定，再重新測試。",
    PROVIDER_MODELS_UNAVAILABLE: "目前無法取得模型，請確認帳號與連線。",
    DAEMON_UNREACHABLE: "Paseo 尚未連線，請先啟動服務。",
    NO_AVAILABLE_MODEL: "目前沒有可用模型。",
    LOCK_BUSY: "另一個操作正在進行，請稍後重新整理。",
    OPERATION_BUSY: "另一個操作正在進行，請稍後重新整理。",
    LOGIN_UNSUPPORTED: "此服務尚未提供網頁登入流程，請由主機管理員協助官方授權。",
    HOST_ONBOARDING_UNAVAILABLE: "目前無法開啟設定對話，請稍後重試。",
  };
  const $ = id => document.getElementById(id);
  if (!$("enable")) return;
  const text = (id, value) => { $(id).textContent = value; };
  const clean = value => typeof value === "string" && value.length <= 300 &&
    !/[\u0000-\u001f\u007f]/.test(value) ? value : "";
  const timestamp = value => typeof value === "string" &&
    /^\d{4}-\d\d-\d\dT/.test(value) && Number.isFinite(Date.parse(value)) ? value : null;
  const dateLabel = value => timestamp(value) ? new Date(value).toLocaleString("zh-TW") : "時間未提供";
  let status = null, catalog = null, busy = false, authBlocked = false, disposed = false;
  let generation = 0, visibilityGeneration = 0, readController = null;
  let pageGeneration = 0, mutationGeneration = 0, transientGeneration = 0;
  let pendingOperation = null, operationMessage = null;
  let pollTimer = null, attempts = 0, transientTimer = null, loginProvider = null;
  let authTimer = null, authAttempts = 0, loginExpiresAt = 0, requiresInput = false;
  const requests = new Set();

  function clearPoll() { clearTimeout(pollTimer); pollTimer = null; }
  function clearTransient() {
    transientGeneration += 1;
    clearTimeout(transientTimer); transientTimer = null;
    clearTimeout(authTimer); authTimer = null;
    requiresInput = false; $("login-code-input").value = ""; $("login-input").hidden = true;
    for (const id of ["pair-link", "login-link"]) {
      $(id).removeAttribute("href");
      $(id).hidden = true;
    }
    for (const id of ["pair-panel", "login-panel", "login-code"]) $(id).hidden = true;
    text("login-code", "");
    text("login-message", "");
  }
  function clearCatalog() {
    catalog = null;
    options("model", [], "先讀取模型");
    options("mode", [], "使用服務預設");
  }
  function options(id, rows, placeholder, preferred) {
    const select = $(id);
    select.replaceChildren();
    const add = (value, label) => {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      select.appendChild(option);
    };
    if (id === "mode" || !rows.length) add("", placeholder);
    for (const row of rows) add(row.id, row.label);
    select.value = rows.some(row => row.id === preferred) ? preferred : (id === "mode" ? "" : rows[0]?.id || "");
  }
  function controls() {
    const locked = busy || authBlocked || disposed || status?.operation?.pending === true;
    const reachable = status?.daemon?.reachable === true;
    for (const id of ["enable", "disable", "login", "onboarding"]) $(id).disabled = locked || !status;
    $("enable").disabled ||= status?.pluginInstalled === false || reachable && status?.desiredEnabled === true;
    $("disable").disabled ||= !status?.desiredEnabled && !status?.daemon?.running;
    for (const id of ["models", "pair"]) $(id).disabled = locked || !reachable;
    $("provider").disabled = locked;
    $("model").disabled = locked || !reachable || !catalog?.models.length;
    $("mode").disabled = locked || !reachable || !catalog?.modes.length;
    $("acceptance").disabled = locked || !reachable || !catalog?.models.some(row => row.id === $("model").value);
    $("refresh").disabled = busy || disposed;
    for (const id of ["login-status", "login-cancel"]) $(id).disabled = locked || !loginProvider;
    $("login-submit").disabled = locked || !loginProvider || !requiresInput;
    document.body.setAttribute("aria-busy", busy ? "true" : "false");
  }
  function schedulePoll(delayMs = 15000) {
    clearPoll();
    if (disposed || authBlocked || busy || document.hidden) return;
    if (attempts >= 20) {
      text("refresh-note", "自動更新已暫停。按「重新整理」取得最新狀態。");
      return;
    }
    pollTimer = setTimeout(async () => {
      pollTimer = null;
      if (disposed || busy || document.hidden || authBlocked) return;
      attempts += 1;
      await refresh();
    }, delayMs);
  }
  function scheduleAuthPoll() {
    clearTimeout(authTimer); authTimer = null;
    if (!loginProvider || disposed || busy || authBlocked || document.hidden || status?.operation?.pending) return;
    if (authAttempts >= 24 || Date.now() >= loginExpiresAt) {
      clearTransient(); loginProvider = null; controls();
      text("notice", "登入進度更新已暫停，需要時請重新開始官方授權。");
      return;
    }
    authTimer = setTimeout(() => {
      authTimer = null;
      if (!loginProvider || busy || disposed || document.hidden) return;
      authAttempts += 1;
      void mutate("login", { provider: loginProvider, step: "status" });
    }, 5000);
  }
  function errorMessage(error) {
    if (error?.code === "AUTH_REQUIRED") return "設定需要 OpenDesign 登入。請回到 OpenDesign 重新登入，再重新整理。";
    if (error?.code === "REQUEST_TIMEOUT") return "等待回應逾時，結果尚未確認。請重新整理確認狀態後再操作。";
    return diagnostics[error?.code] || "目前無法完成操作，請稍後重新整理。";
  }
  async function request(method, body, controller, timeoutMs) {
    const fail = code => Object.assign(new Error(code), { code });
    requests.add(controller);
    let timer;
    try {
      return await Promise.race([
        (async () => {
          const response = await fetch(endpoint, {
            method, credentials: "same-origin", cache: "no-store", redirect: "error",
            headers: { Accept: "application/json", ...(method === "POST" ? { "Content-Type": "application/json" } : {}) },
            ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
            signal: controller.signal,
          });
          if (response.status === 401 || response.status === 403) {
            throw fail("AUTH_REQUIRED");
          }
          if (!response.ok) {
            const dto = await response.json().catch(() => ({}));
            throw fail(Object.hasOwn(diagnostics, dto?.error?.code || dto?.code) ? dto.error?.code || dto.code : "REQUEST_FAILED");
          }
          if (!response.headers.get("content-type")?.includes("application/json")) throw fail("INVALID_RESPONSE");
          const dto = await response.json();
          if (!dto || typeof dto !== "object" || Array.isArray(dto)) throw fail("INVALID_RESPONSE");
          return { dto, accepted: response.status === 202 };
        })(),
        new Promise((_, reject) => {
          timer = setTimeout(() => { controller.abort(); reject(fail("REQUEST_TIMEOUT")); }, timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer); requests.delete(controller);
    }
  }
  function renderHistory(result) {
    $("history").replaceChildren();
    if (!timestamp(result?.checkedAt)) {
      text("history-time", "尚無測試紀錄。紀錄不代表目前仍能對話。");
      return;
    }
    text("history-time", "紀錄更新：" + dateLabel(result.checkedAt) + "。各服務可能來自不同次測試；這是歷史紀錄，不代表目前仍能對話。");
    for (const provider of providers) {
      const row = result.providers?.find(item => item?.provider === provider);
      const passed = row?.passed === true && row.firstReply === true && row.followup === true;
      const tr = document.createElement("tr");
      const values = [
        names[provider], row ? [clean(row.model), clean(row.modeId)].filter(Boolean).join(" / ") || "未提供" : "—",
        row?.firstReply === true ? "已取得" : "未確認",
        row?.followup === true ? "已取得" : "未確認",
        passed ? "兩輪通過" : row ? "尚未通過" : "尚未測試",
      ];
      for (const value of values) {
        const cell = document.createElement("td"); cell.textContent = value; tr.appendChild(cell);
      }
      $("history").appendChild(tr);
    }
  }
  function onboardingLink(value) {
    $("onboarding-link").hidden = true;
    $("onboarding-link").removeAttribute("href");
    if (typeof value !== "string" || value.length > 2048) return;
    try {
      const url = new URL(value, window.location.origin);
      if (url.origin !== window.location.origin || url.username || url.password || url.hash ||
          [...url.searchParams].some(([key, value]) => !["conversation", "conversationId", "projectId"].includes(key) || !/^[A-Za-z0-9_-]{1,200}$/.test(value))) return;
      $("onboarding-link").setAttribute("href", url.pathname + url.search);
      $("onboarding-link").hidden = false;
    } catch {}
  }
  function settleOperation(dto) {
    operationMessage = null;
    const operation = dto.operation;
    if (!pendingOperation || !operation || operation.action !== pendingOperation.action ||
        pendingOperation.id && pendingOperation.id !== operation.id) return;
    if (!["completed", "error", "interrupted"].includes(operation.status)) return;
    const pending = pendingOperation;
    pendingOperation = null;
    if (operation.status !== "completed") {
      operationMessage = diagnostics[operation.code] || "操作尚未完成，請確認狀態後重試。";
      if (pending.action === "acceptance") text("test-result", "本次測試未完成；上次紀錄不代表本次通過。");
      return;
    }
    operationMessage = "操作已完成，狀態已更新。";
    if (pending.action === "acceptance") {
      const result = dto.lastVerification || dto.acceptance;
      const row = result?.providers?.find(item => item?.provider === pending.provider);
      const fresh = timestamp(result?.checkedAt) && Date.parse(result.checkedAt) >= pending.requestedAt &&
        row?.model === pending.model && (!pending.mode || row?.modeId === pending.mode);
      const passed = fresh && row.passed === true && row.firstReply === true && row.followup === true;
      text("test-result", names[pending.provider] + (passed ? "：本次已取得兩輪回覆（" : "：本次尚未確認兩輪回覆（") +
        dateLabel(result?.checkedAt) + "）。");
    }
  }
  function renderStatus(dto) {
    if (dto.schemaVersion !== 1 || !dto.daemon || typeof dto.daemon.reachable !== "boolean" ||
        !Array.isArray(dto.providers)) throw Object.assign(new Error("INVALID_RESPONSE"), { code: "INVALID_RESPONSE" });
    settleOperation(dto);
    // Keep only the public DTO fields used by this page; do not cache raw runtime state.
    status = {
      pluginInstalled: typeof dto.pluginInstalled === "boolean" ? dto.pluginInstalled : null,
      phase: clean(dto.phase), desiredEnabled: dto.desiredEnabled === true,
      daemon: { running: dto.daemon.running === true, reachable: dto.daemon.reachable, relayEnabled: dto.daemon.relayEnabled === true },
      operation: { pending: dto.operation?.pending === true || ["queued", "running"].includes(dto.operation?.status) || pendingOperation !== null },
    };
    text("phase", dto.installed === false ? "尚未安裝" : phaseLabels[status.phase] || "狀態待確認");
    text("version", clean(dto.version) || "尚未安裝");
    text("enable", clean(dto.version) ? "啟動服務" : "安裝並啟動");
    text("daemon", status.daemon.reachable ? "Paseo 可連線（目前檢查）" : "目前尚未連線");
    text("observed", new Date().toLocaleString("zh-TW"));
    for (const provider of providers) {
      const entry = dto.providers.find(row => row?.provider === provider);
      let label = "狀態待確認";
      if (entry?.authentication === "login_required") label = "需要官方登入";
      else if (["authenticated", "authorized"].includes(entry?.authentication)) label = "已確認帳號授權";
      else if (entry?.status === "unavailable") label = "目前無法使用";
      else if (["ready", "available"].includes(entry?.status)) label = "工具可用；帳號授權待確認";
      text("provider-" + provider, label);
    }
    if (!status.daemon.reachable) clearCatalog();
    renderHistory(dto.lastVerification || dto.acceptance);
    onboardingLink(dto.onboarding?.url);
    controls();
  }
  async function refresh(manual = false) {
    if (disposed || busy || readController || document.hidden) return;
    if (manual) {
      authBlocked = false; attempts = 0;
      text("refresh-note", "每 15 秒更新，最多約 5 分鐘；操作期間會暫停更新。");
    }
    if (authBlocked) return;
    clearPoll();
    const controller = new AbortController(), issued = ++generation;
    readController = controller;
    try {
      const { dto } = await request("GET", undefined, controller, 15000);
      if (disposed || issued !== generation || busy || controller.signal.aborted) return;
      renderStatus(dto);
      text("notice", operationMessage || (status.operation.pending ? "服務正在處理操作，完成後會更新狀態。" : "狀態已更新。"));
    } catch (error) {
      if (disposed || issued !== generation || controller.signal.aborted && error.code !== "REQUEST_TIMEOUT") return;
      if (error.code === "AUTH_REQUIRED") authBlocked = true;
      status = null; clearCatalog(); clearTransient();
      text("phase", "目前狀態未確認");
      text("daemon", "目前狀態未確認");
      text("observed", "更新失敗；畫面紀錄不代表目前狀態");
      for (const provider of providers) text("provider-" + provider, "目前狀態未確認");
      text("notice", errorMessage(error));
      controls();
    } finally {
      if (readController === controller) readController = null;
      schedulePoll(); scheduleAuthPoll();
    }
  }
  function expireTransient(expiresAt) {
    clearTimeout(transientTimer);
    const expiry = timestamp(expiresAt);
    const duration = expiry ? Math.min(120000, Date.parse(expiry) - Date.now()) : 120000;
    if (duration <= 0) { clearTransient(); loginProvider = null; text("notice", "連結已到期，請重新建立。"); return false; }
    transientTimer = setTimeout(() => {
      clearTransient(); loginProvider = null; controls();
      text("notice", "暫時資訊已隱藏，需要時請重新建立。");
    }, duration);
    return true;
  }
  function officialURL(value, kind, provider) {
    if (typeof value !== "string" || value.length > 12000) return null;
    try {
      const url = new URL(value);
      const loginHosts = {
        claude: ["claude.ai", "console.anthropic.com", "auth.anthropic.com", "platform.claude.com"],
        codex: ["auth.openai.com", "platform.openai.com", "openai.com"],
        pi: ["auth.openai.com", "platform.openai.com", "openai.com"],
      };
      const allowed = kind === "pair" ? ["app.paseo.sh"] : loginHosts[provider] || [];
      if (url.protocol !== "https:" || url.username || url.password || url.port ||
          !allowed.includes(url.hostname) || kind === "pair" && url.search) return null;
      return url.href;
    } catch { return null; }
  }
  async function mutate(action, extra = {}) {
    if (busy || authBlocked || disposed || status?.operation?.pending) return;
    const previousSelection = action === "models" && catalog?.provider === extra.provider
      ? { model: $("model").value, mode: $("mode").value } : null;
    const issuedMutation = ++mutationGeneration, pageAtStart = pageGeneration;
    busy = true; clearPoll();
    clearTimeout(authTimer); authTimer = null;
    if (action !== "login" || extra.step !== "status") clearTransient();
    if (action !== "login") { loginProvider = null; loginExpiresAt = 0; }
    if (action === "login" && extra.step === "start") { clearCatalog(); authAttempts = 0; loginExpiresAt = Date.now() + 120000; }
    generation += 1;
    if (readController) { readController.abort(); readController = null; }
    const visibleAtStart = visibilityGeneration, transientAtStart = transientGeneration, operationStartedAt = Date.now();
    const labels = {
      enable: "正在安裝或啟動，請稍候…", disable: "正在停止服務…",
      models: "正在取得可用模型…", pair: "正在建立配對連結…",
      login: "正在處理官方帳號授權…", onboarding: "正在開啟既有設定對話…",
      acceptance: "正在實際測試兩輪對話，請稍候…",
    };
    text("notice", labels[action]); controls();
    try {
      const { dto, accepted } = await request("POST", { action, ...extra }, new AbortController(), action === "acceptance" ? 300000 : 180000);
      if (disposed || issuedMutation !== mutationGeneration || pageAtStart !== pageGeneration) return;
      if (accepted) {
        if (!["enable", "disable", "acceptance", "onboarding"].includes(action)) throw new Error("INVALID_RESPONSE");
        if (!clean(dto.operation?.id) || dto.operation.action !== action ||
            !["queued", "running", "completed", "error", "interrupted"].includes(dto.operation.status)) {
          status = null; clearCatalog(); throw new Error("INVALID_RESPONSE");
        }
        const provider = extra.providers?.[0];
        const startedAt = timestamp(dto.operation.startedAt);
        pendingOperation = { action, provider, requestedAt: startedAt ? Date.parse(startedAt) : operationStartedAt, id: dto.operation.id,
          model: extra.models?.[provider], mode: extra.modes?.[provider] || null };
        if (status) status.operation.pending = true;
        text("notice", "操作已接收，正在處理。完成前請稍候。");
        if (action === "acceptance") text("test-result", "本次測試正在進行；上次紀錄不代表本次結果。");
        return;
      }
      if (action === "enable" || action === "disable") renderStatus(dto);
      if (action === "models") {
        if (dto.provider !== extra.provider || !Array.isArray(dto.models) || !Array.isArray(dto.modes)) throw new Error("INVALID_RESPONSE");
        const rows = list => list.slice(0, 2000).filter(row => clean(row?.id)).map(row => ({ id: row.id, label: clean(row.label) || row.id, isDefault: row.isDefault === true }));
        catalog = { provider: extra.provider, models: rows(dto.models), modes: rows(dto.modes) };
        catalog.defaultModeId = catalog.modes.some(row => row.id === dto.defaultModeId) ? dto.defaultModeId : null;
        const model = catalog.models.some(row => row.id === previousSelection?.model)
          ? previousSelection.model : catalog.models.find(row => row.isDefault)?.id;
        const mode = previousSelection && (previousSelection.mode === "" || catalog.modes.some(row => row.id === previousSelection.mode))
          ? previousSelection.mode : catalog.defaultModeId;
        options("model", catalog.models, "目前沒有可用模型", model);
        options("mode", catalog.modes, "使用服務預設", mode);
      }
      if (action === "onboarding") {
        onboardingLink(dto.url);
        if ($("onboarding-link").hidden) throw new Error("INVALID_RESPONSE");
      }
      if (action === "acceptance") {
        const result = dto.acceptance || dto;
        renderHistory(result);
        const row = result.providers?.find(item => item?.provider === extra.providers[0]);
        const provider = extra.providers[0];
        const fresh = timestamp(result.checkedAt) && Date.parse(result.checkedAt) >= operationStartedAt &&
          row?.model === extra.models[provider] && (!extra.modes?.[provider] || row.modeId === extra.modes[provider]);
        const passed = fresh && row.passed === true && row.firstReply === true && row.followup === true;
        text("test-result", names[extra.providers[0]] + (passed ? "：本次已取得兩輪回覆（" : "：本次尚未確認兩輪回覆（") + dateLabel(result.checkedAt) + "）。" +
          (!passed && Object.hasOwn(diagnostics, row?.code) ? " " + diagnostics[row.code] : ""));
      }
      if (["pair", "login"].includes(action) && (document.hidden || visibleAtStart !== visibilityGeneration || transientAtStart !== transientGeneration)) {
        text("notice", "操作已回覆；暫時資訊因頁面隱藏而清除，需要時請重新取得。");
        return;
      }
      if (action === "pair") {
        const url = officialURL(dto.url, "pair");
        if (!url) throw new Error("INVALID_RESPONSE");
        if (!expireTransient(dto.expiresAt)) return;
        $("pair-link").setAttribute("href", url); $("pair-link").hidden = false;
        $("pair-panel").hidden = false; $("pair-link").focus();
      }
      if (action === "login") {
        const loginState = dto.state || ({
          idle: "idle", starting: "pending", awaiting_authorization: "pending",
          authorization_completed: "complete", credential_present: "credential_present",
          interactive_required: "unsupported", cancelled: "cancelled", expired: "expired", error: "error",
        }[dto.phase]) || (dto.requiresCode === true || dto.requiresInput === true || dto.manualCodeRequired === true ? "pending" : null);
        if (dto.provider !== extra.provider || !["idle", "pending", "complete", "credential_present", "unsupported", "cancelled", "expired", "error"].includes(loginState)) throw new Error("INVALID_RESPONSE");
        loginProvider = loginState === "pending" ? extra.provider : null;
        if (loginState !== "pending") clearTransient();
        $("login-panel").hidden = false;
        text("login-message", {
          pending: "請到官方頁面完成授權，再按「確認狀態」。",
          complete: "官方登入流程已完成。請重新讀取模型，再測試對話。",
          credential_present: "已偵測到帳號設定，仍需讀取模型並測試對話。",
          idle: "官方登入尚未開始，請按「登入與帳號設定」。",
          expired: "登入流程已到期，請重新開始。",
          error: "官方登入未完成，請確認帳號後再試。",
          unsupported: "此服務尚未提供網頁登入流程。請由主機管理員協助完成官方授權，再回到本頁確認。",
          cancelled: "登入流程已取消。",
        }[loginState]);
        if (loginState === "pending") {
          loginExpiresAt = Math.min(loginExpiresAt || Date.now() + 120000, timestamp(dto.expiresAt) ? Date.parse(dto.expiresAt) : Infinity);
          if (!expireTransient(new Date(loginExpiresAt).toISOString())) return;
          requiresInput = extra.provider === "pi" && (dto.requiresCode === true || dto.requiresInput === true || dto.manualCodeRequired === true);
          $("login-input").hidden = !requiresInput;
          if (!requiresInput) $("login-code-input").value = "";
          if (requiresInput) text("login-message", "請完成官方授權，再將官方回呼網址或授權代碼提交到此處。");
          if (dto.authorizationUrl || dto.url) {
            const url = officialURL(dto.authorizationUrl || dto.url, "login", extra.provider);
            if (!url) throw new Error("INVALID_RESPONSE");
            $("login-link").setAttribute("href", url); $("login-link").hidden = false;
          }
          const deviceCode = dto.deviceCode || dto.userCode;
          if (typeof deviceCode === "string" && /^[A-Z0-9-]{3,64}$/i.test(deviceCode)) {
            text("login-code", "在官方頁面輸入代碼：" + deviceCode); $("login-code").hidden = false;
          }
        }
      }
      text("notice", action === "models" && !catalog.models.length ? "目前沒有可用模型，請先確認官方登入。" :
        action === "pair" ? "配對連結已建立。請到官方 App 完成配對。" :
        action === "acceptance" ? "測試結果已更新，請查看下方兩輪回覆結果。" : "操作已回覆。");
    } catch (error) {
      if (disposed || issuedMutation !== mutationGeneration || pageAtStart !== pageGeneration) return;
      if (error.code === "AUTH_REQUIRED") authBlocked = true;
      if (action === "login") loginProvider = null;
      clearTransient();
      if (action === "models") clearCatalog();
      if (action === "acceptance") text("test-result", "本次測試結果尚未確認；上次紀錄不代表本次通過。");
      if (action === "enable" || action === "disable" || authBlocked) {
        status = null; clearCatalog(); text("phase", "操作結果未確認"); text("daemon", "請重新整理確認目前狀態");
      }
      text("notice", errorMessage(error));
    } finally {
      if (issuedMutation === mutationGeneration && pageAtStart === pageGeneration) {
        busy = false; controls(); schedulePoll(pendingOperation ? 1000 : 15000); scheduleAuthPoll();
      }
    }
  }
  $("refresh").addEventListener("click", () => { void refresh(true); });
  for (const action of ["enable", "disable", "pair", "onboarding"]) {
    $(action).addEventListener("click", () => { void mutate(action); });
  }
  $("models").addEventListener("click", () => { void mutate("models", { provider: $("provider").value }); });
  $("provider").addEventListener("change", () => {
    clearCatalog(); clearTransient(); loginProvider = null; controls();
    text("notice", "服務已切換，請讀取此服務的模型。");
  });
  for (const id of ["model", "mode"]) $(id).addEventListener("change", controls);
  $("acceptance").addEventListener("click", () => {
    const provider = $("provider").value, model = $("model").value, mode = $("mode").value || catalog?.defaultModeId || "";
    if (catalog?.provider !== provider || !catalog.models.some(row => row.id === model) ||
        mode && !catalog.modes.some(row => row.id === mode)) return;
    void mutate("acceptance", { providers: [provider], models: { [provider]: model }, ...(mode ? { modes: { [provider]: mode } } : {}) });
  });
  $("login").addEventListener("click", () => { void mutate("login", { provider: $("provider").value, step: "start" }); });
  $("login-submit").addEventListener("click", () => {
    if (loginProvider !== "pi" || !requiresInput) return;
    const code = $("login-code-input").value.trim();
    if (!code || code.length > 2048) { text("notice", "請輸入官方授權結果，最多 2,048 個字元。"); return; }
    void mutate("login", { provider: "pi", step: "complete", code });
  });
  for (const step of ["status", "cancel"]) $("login-" + step).addEventListener("click", () => {
    if (loginProvider) void mutate("login", { provider: loginProvider, step });
  });
  $("pair-close").addEventListener("click", clearTransient);
  $("login-close").addEventListener("click", () => { clearTransient(); loginProvider = null; controls(); });
  document.addEventListener("visibilitychange", () => {
    visibilityGeneration += 1; clearTransient(); loginProvider = null;
    if (document.hidden) {
      clearPoll(); generation += 1;
      if (readController) { readController.abort(); readController = null; }
    } else schedulePoll();
    controls();
  });
  window.addEventListener("pagehide", () => {
    disposed = true; generation += 1; visibilityGeneration += 1; pageGeneration += 1; mutationGeneration += 1;
    busy = false; status = null; clearCatalog(); readController = null;
    clearPoll(); clearTransient(); loginProvider = null;
    for (const controller of requests) controller.abort();
  });
  window.addEventListener("pageshow", event => {
    if (event.persisted) { disposed = false; status = null; authBlocked = false; attempts = 0; controls(); void refresh(true); }
  });
  void refresh();
})();
