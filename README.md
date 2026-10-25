# OpenDesign CLI image + Paseo launcher

本 repo 提供預裝 Claude Code、Codex、Pi 的 OpenDesign 映像，以及可選的 **Paseo 原生外掛入口**。

## Paseo 的 GUI 操作

支援此整合的主機啟用後：

1. 進入 OpenDesign **外掛 → Expert suites → 已安裝**。
2. 在 **Paseo 設定** 卡片按 **開啟**，以新分頁開啟同網域設定頁。
3. 查看安裝進度與現有 Claude Code、Codex、Pi 帳號狀態。
4. 選擇服務、模型與模式，執行兩輪對話測試。
5. 產生配對連結，在官方 Paseo App 完成連接後開始對話。

首次啟用會下載鎖定版本的執行套件並建立初始化對話；已有屬於此整合的對話會被沿用。手動停止會持久保存，重啟 OD 不會擅自再次啟用。

**主機需求：** 原生 `od.launch` 外掛入口、原子 MCP 單筆更新 API、同源驗證代理、持久化 HOME／資料目錄及受管理的 Paseo 程序。[部署方式與限制](docs/native-launcher.md)。一般 OD 的「從 Git 匯入 Skill」本身不會安裝後端服務。

[2026-10-25 實測紀錄](docs/native-launcher-verification-20261025.md)：三種代理均已在官方 Paseo App 完成兩輪對話。平台完整 Redeploy 的商品範本整合尚未完成，目前適用於明確啟用的相容主機。

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
