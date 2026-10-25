# OpenDesign 預裝 CLI 映像驗收

## 目標行為

全新 OpenDesign 容器啟動時，`claude`、`codex`、`pi` 已在全域 PATH 中。OpenDesign 以產品 UID 1001 執行；無需使用者匯入 Paseo 插件、觸發背景下載或建立安裝對話。使用者透過 OpenDesign GUI 的 **Local AI → Rescan** 發現工具，再完成各自的官方帳號登入。

## 固定映像版本

- OpenDesign `0.24.1`，上游映像以 digest 固定
- Claude Code `2.1.296`
- Codex CLI `0.162.1`
- Pi Coding Agent `1.1.0`
- PaaS 代理初始化還需要 `python3`；映像另備有 `bash`、`curl`、`gcompat`、`libgcc`、`libstdc++`、`ripgrep` 和 `tini`

## 2026-10-12 冷安裝實測

在經授權的隔離服務，以原生 PaaS 重配置流程部署不可變候選映像。服務位址、儲存卷與實際映像識別保留於私有驗收紀錄。

已驗證：

- Kaniko 從固定 OpenDesign Alpine 基底安裝三個固定版本；建置階段以 UID 1001 執行 `claude --version`、`codex --version`、`pi --version` 均成功。
- 真實 PaaS 啟動完成，所有初始化容器與 OpenDesign 主容器 Ready。容器為 UID/GID 1001；`python3 3.14.8` 及三個 CLI 都可由 PATH 找到並執行。
- OpenDesign GUI 一般登入後進入 **Local AI → Rescan**，列出 Claude Code `2.1.296`、Codex `0.162.1`、Pi `1.1.0`；三個項目各自可選取。320、390、768、1280px 寬度均無水平溢位或前端例外。
- 部署移除 `NODE_OPTIONS` 中 Paseo preload，並刪除 測試服務 HOME 與 OpenDesign 資料卷內專屬的 Paseo host adapter、release/runtime state 及交易目錄。Claude、Codex、Pi 使用者設定和授權資料未刪除或寫入映像。
- GUI 驗收未按「Test」或「Continue」，沒有從驗收流程送出測試對話。部署後啟動沒有下載 CLI 的背景步驟。

## 發現並修正

第一次候選映像省略了 `python3`。PaaS 的 `agent-defaults` 初始化容器依賴該命令，因此全新 Pod 停在初始化階段。已透過 PaaS 原生流程恢復先前映像並保留移除 Paseo preload 的設定，將 `python3` 加回映像後重建；最終版本的初始化容器已實際通過。這項依賴已加入建置文件與契約測試。

## 已知限制

OpenDesign 載入頁的可選 AMR/Vela 背景端點回覆 `500: AMR vela binary could not be resolved` 及 `503: amr-runtime-unavailable`。這與 Local AI CLI 掃描分開；三個 CLI 可見、可選，GUI 無前端例外。若要使用 Vela 整合，需另行提供該 runtime。

此租戶未以 Claude、OpenAI 或 Pi 供應商帳號授權，故未執行模型對話驗收。CLI 已安裝不代表帳號已登入；使用者須透過各 CLI 的官方流程完成授權。映像不包含 API key、OAuth token 或個人設定。

## 升級與回復

版本升級前需重建映像，檢查三個 CLI 在目標 Alpine 架構上的相容性，並驗證 PaaS 初始化、原生 Local AI 掃描和 GUI 選擇。保留先前 OpenDesign image digest；若新映像無法啟動，使用 PaaS 原生流程還原 digest，同時保留 HOME 與 OpenDesign 資料 PVC。
