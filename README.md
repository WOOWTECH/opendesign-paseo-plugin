# OpenDesign 內建 Claude Code、Codex 與 Pi CLI

這個專案現在提供 OpenDesign 預裝 CLI 的 OCI 映像。OpenDesign 服務啟動後，產品使用者即可在終端與 Local AI 清單中使用 Claude Code、Codex、Pi Coding Agent，不必匯入或安裝 Paseo 插件，也不會在第一次對話時才下載 CLI。

映像固定 OpenDesign 0.24.1 及以下 CLI 版本：

- Claude Code `2.1.296`
- Codex CLI `0.162.1`
- Pi Coding Agent `1.1.0`

管理員部署本 repo 的 `image/Dockerfile` 建出的映像即可。建置期間會以 OpenDesign UID 1001 執行三個 CLI 的版本檢查；任一命令無法啟動，建置就會失敗。服務啟動沿用 OpenDesign 原生 daemon，不注入 Paseo host adapter、preload 或安裝器。

使用者首次使用時，在 OpenDesign GUI 開啟 **Local AI → Rescan**，選擇所需 CLI，再依各工具的官方流程登入自己的帳號。映像只提供程式，不含任何個人授權或 API key；能執行 CLI 不代表帳號已授權或模型對話已驗收。

## 建置與驗收

```sh
docker build -f image/Dockerfile -t opendesign-cli-bundle:test .
npm test -- tests/image-preinstalled-clis.test.mjs
```

完整的冷啟動、GUI 掃描與服務驗收紀錄放在 [預裝 CLI 映像說明](docs/preinstalled-cli-image.md)。

## 舊 Paseo 插件

舊版 Paseo 插件已從 OpenDesign 測試服務的啟動鏈移除，使用者不需要也不應安裝該插件。這個 GitHub repo 現在用來建置與驗收預裝 CLI 映像；請勿再使用過去的 Paseo 插件匯入步驟。
