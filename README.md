# OpenDesign CLI image + Paseo launcher

本 repo 提供預裝 Claude Code、Codex、Pi 的 OpenDesign 映像，以及可選的 **Paseo 原生外掛入口**。

## Paseo 的 GUI 操作

支援此整合的主機啟用後：

1. 進入 OpenDesign **Plugins（外掛）→ Expert suites → Personal**。目前英文介面將已安裝的原生入口放在 `Personal` 分頁。
2. 在 **Paseo** 卡片按 **Open**，以新分頁開啟同網域的「Paseo 安裝與連線設定」頁。
3. 查看安裝進度與現有 Claude Code、Codex、Pi 帳號狀態；尚未登入時按 **登入與帳號設定**，依[GUI 帳號連結](docs/native-launcher.md#gui-帳號連結)完成官方授權。
4. 選擇服務、模型與模式，執行兩輪對話測試。
5. 產生配對連結，在官方 Paseo App 完成連接後開始對話。

鎖定版本的 Paseo 執行套件由映像在建置時內建於 `<套件根目錄>/managed-runtime`，首次啟用不執行 npm、不需要套件庫連線；未內建的主機才會下載該執行套件（約 0.8 GB）。新安裝預設關閉本機語音（`features.dictation`／`features.voiceMode`），避免 daemon 啟動時從 github.com 下載約 0.7 GiB 語音模型。首次啟用會建立初始化對話；已有屬於此整合的對話會被沿用。手動停止會持久保存，重啟 OD 不會擅自再次啟用。

**主機需求：** 原生 `od.launch` 外掛入口、原子 MCP 單筆更新 API、同源驗證代理、持久化 HOME／資料目錄及受管理的 Paseo 程序。[部署方式與限制](docs/native-launcher.md)。一般 OD 的「從 Git 匯入 Skill」本身不會安裝後端服務。

[登入修正與實測](docs/native-auth-verification-20261025.md)涵蓋官方授權分頁返回與預裝 Pi SDK 載入。[正式環境驗收（2026-10-26）](docs/production-redeploy-verification-20261026.md)：平台部署政策已發布，兩台指定主機各完成兩次原生完整 Redeploy，固定映像、chart、資料與初始化對話均保留。目前適用於明確啟用的相容主機；一般 OD 匯入 Skill 仍不會自動安裝後端，候選版本也不代表任意主機皆可直接安裝。

## 預裝 CLI 映像

原有 `image/Dockerfile` 持續提供 CLI 預裝功能，不會自動啟用 Paseo。歷史驗收紀錄見 [預裝 CLI 映像說明](docs/preinstalled-cli-image.md)。

## 開發驗證

```sh
npm ci --ignore-scripts
npm test
npm run check
npm run check:launcher
npm audit --omit=dev
npm audit --omit=dev --prefix vendor/pi-paseo/runtime
```

`npm test` 包含現行 CLI 映像契約、launcher、執行環境、初始化、安全與設定頁測試。其餘舊版 preload／overlay 測試屬於已停用架構，未列入現行測試命令。

## 版本沿革

- `0.1.0`：舊 Paseo 整合曾採 preload／overlay；後續主線改為 CLI 映像。
- `0.2.0`：可選的獨立 Paseo 服務、原生 bundled 入口與同源設定頁。舊 `install-host.mjs`／preload 不再出現在發行包中。
- `0.2.1`：原生外掛入口、PaaS／Home Assistant 認證適配與兩輪對話驗收流程。
- `0.2.2`：修正 Claude Code 官方登入網址與完成碼的 GUI 流程，延長官方授權等待時間。
