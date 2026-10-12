# OpenDesign 內建 CLI 映像

映像以 digest 固定 OpenDesign 0.24.1，並在映像建置時預裝 Claude Code、Codex CLI 與 Pi Coding Agent。命令安裝在全域 PATH，OpenDesign 產品使用者 UID 1001 在新容器啟動時即可執行，不需要匯入 Paseo 插件，也不會在啟動時下載套件或建立測試對話。

目前固定版本：Claude Code 2.1.296、Codex 0.162.1、Pi Coding Agent 1.1.0。建置步驟會以產品 UID 執行三個 `--version`，不通過就中止映像建置。映像不包含使用者登入資料；使用者第一次使用時要在 OpenDesign GUI 選 Local AI → Rescan，選擇 CLI 並完成各自的官方登入。

```sh
docker build -f image/Dockerfile -t opendesign-cli-bundle:test .
```

執行身分維持 UID/GID 1001，OpenDesign 原生 daemon、持久卷與登入保護沿用上游/PaaS 設定。映像沒有 Paseo 主機適配層或 NODE_OPTIONS preload。
