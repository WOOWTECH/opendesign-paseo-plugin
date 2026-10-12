# 無預裝代理的 OpenDesign 測試映像

此映像固定上游 OpenDesign 0.24.1 的 digest，準備 Node、npm 10.9.4、Python、curl、tini 與本插件主機適配層。**不安裝 Claude Code 或 Codex**；兩者由使用者在原生 Plugins 匯入插件後觸發下載。

```sh
docker build -f image/Dockerfile -t opendesign-agent-runtime:test .
```

建置以 root 準備系統依賴，執行時為 uid/gid 1001。建置最後也以此身分檢查工具版本、Claude/Codex 缺少。啟動時先以產品使用者在 HOME 準備受校驗 release，再保留 NODE_OPTIONS 並由 tini 啟動原生 daemon。

部署需提供可寫且獨立的 HOME `/home/opendesign`、資料 `/app/.od` 持久卷，以及原平台的反向代理登入保護。GUI origin 必須放在 OD_ALLOWED_ORIGINS；不要關閉來源檢查。curl 是目前 chart 啟動/存活探針的前置條件。HOME 有明確預設；平台也可保存相同設定，避免換映像後退回 /root。

換映像前先核對完整六檔 host profile，不支援未知或混合來源。平台的全量命名空間配置可能重設 PVC 數量上限，管理員應按已授權服務數量、實際資料卷需求與儲存配額完成部署，而非把 preflight 取消或刪除其他租戶的資料卷。

本次真實平台部署已驗证 daemon 健康、兩個 CLI/launcher/登入資料均不存在。未匯入插件，沒有預先替測試者下載代理或借用其他環境的登入。登入驗證與模型回覆由測試者完成官方授權後另外執行。

完全沒有 CLI 時，原生歡迎頁可能無法進入 Plugins。先開 `/paseo/setup` 的「首次安裝連線插件」按鈕，透過原生安裝 API 完成匯入；GUI 驗證 pluginInstalled 後才回報成功。操作逾時不盲目重試，重新整理先查看登錄狀態。映像將 HOME/.local/bin 加入 PATH，下載後原生 Local AI → Rescan 能偵測同一份 CLI。
