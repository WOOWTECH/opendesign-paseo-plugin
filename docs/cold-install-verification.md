# Claude Code / Codex 從零下載 GUI 驗收

日期：2026-10-12。此項驗收獨立於已有帳號、CLI 的正式環境，不將預裝工具算為安裝成功。

## 起點與流程

使用固定 digest 的上游 OpenDesign 0.24.1 隔離容器，新的 HOME 與資料目錄。GUI 安裝前，`command -v claude`、`command -v codex` 皆失敗，沒有供應商登入目錄；另查 /app 未發現兩個 CLI 執行檔。主機適配層準備完成後、開始 GUI 之前再檢查一次，兩者仍不存在。

此精簡映像只帶 Node，未帶 npm 與 Python。測試先補管理前置工具 npm 10.9.4（registry integrity 校驗）與 Python，沒有預先下載 coding-agent 套件。正式容器應在映像準備階段提供 Node、npm、`/usr/bin/python3`、持久 HOME/data 與適配層；這些與由終端使用者 GUI 觸發的代理安裝分開。

瀏覽器操作 OpenDesign Plugins → Import GitHub URL；真實原生安裝請求 HTTP 200。插件安裝後受控 worker 執行套件下載，GUI 從未安裝→安裝中→服務運作中。沒有用直接 backend 呼叫代替 Import 操作。

## 證據

- 新安裝 Claude Code 2.1.270、Codex 0.162.1，實際 launcher `--version` 成功；來源是本次資料目錄內的 provider packages。
- GUI 停用、重新啟用通過；兩套 package-lock 的 SHA-256 與 mtime 保持不變，沒有重裝。
- GUI Claude/Codex 模型清單載入成功。清單可載入不代表帳號授權或模型回覆成功。
- 冷環境不複製任何原容器 token、登入資料；付費模型對話與官方帳號登入另作授權後驗收。
- 一般 shell 的 PATH 未自動包含 HOME/.local/bin；GUI manager 使用受控 provider PATH，絕對 launcher 可執行。不要宣稱任意 shell 中裸指令都可用。

## 新發現與修正

1. 上游原版 index.html 與先前 base profile 不同，五個 daemon 檔一致。新增 `upstream-od-0.24.1-clean` 的完整六檔 profile，固定映像 index digest。未知、混合指紋仍拒絕，沒有放寬校驗。
2. 原生服務 `OD_ALLOWED_ORIGINS` 空白時，狀態 GET 正常、GUI POST 被拒絕。部署須填該服務精確 GUI origin；測試加單一 loopback origin，不關閉來源驗證。
3. 改用服務相同埠的本機連線轉送通過原生來源檢查；測試頁未暴露公網。
4. 更新主機映像前，需先驗證適配層 profile。未知映像會停止載入，不能把舊版本單次 GUI 通過當成新映像相容證明。

完整 GUI 截圖、測試容器與環境識別資訊保持私密，不發布登入與授權資料。此結果支持「原先沒有 CLI → GUI 觸發真實下載」；不代表已完成全新帳號的授權、跨容器隔離安全認證或任意上游版本支援。

最後驗證：OpenDesign daemon 程序重啟後 GUI 回到服務運作中；兩套 package-lock SHA-256 與 mtime 仍相同，初始化 project/conversation id 沒有變。此為程序重啟驗證，未宣稱已驗證跨 Pod 搬遷；測試容器使用隔離暫存資料卷，正式部署仍要求持久 PVC。合併當前 main 後236項測試與套件語法/包裝檢查全數通過。
