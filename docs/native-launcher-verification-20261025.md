# 原生 Paseo 外掛實測紀錄 — 2026-10-25

## 已完成的操作

在已授權的 OpenDesign 測試服務，透過真實瀏覽器操作：

- 外掛 → Expert suites → 已安裝，三張原生卡片分別開啟 CLI 終端機、MCP Server、Paseo 設定頁。
- 點擊 Paseo 的「開啟」後，以新分頁進入同網域 `/paseo/setup/`。
- 未登入存取設定頁、靜態腳本及 bridge API 均回應 401。
- 自動啟用及 OD 重啟均沿用既有初始化對話。
- GUI 停止後，透過原生 PaaS 重啟工作負載，Paseo 維持停止；GUI 再啟動成功。
- 原生 stdio MCP 列出 `paseo_status`、`paseo_models`、`paseo_createchat`、`paseo_continue`，實際狀態調用成功。
- 官方 Paseo App 使用獨立瀏覽器 context 完成配對，驗證連線主機身份；未傳送 OD Basic Auth 憑證。
- 部署前的 1,832 個專案檔案，部署後逐一 SHA-256 比對相同。

## 官方 App 對話

每個服務均在官方 App 的 GUI 選擇模型、建立對話、發送首輪及追問，兩次回覆均確認同一個隨機測試標記。這不是只檢查 CLI、登入檔或模型清單。

| 服務 | 實測模型 | 模式／限制 | 首輪 | 追問 |
| --- | --- | --- | --- | --- |
| Claude Code | `claude-haiku-4-5` | Always ask | 通過 | 通過 |
| Codex | `gpt-6.1-sol` | Auto-review | 通過 | 通過 |
| Pi | `openrouter/anthropic/claude-haiku-4.5` | 原生輸出上限 2,048 tokens | 通過 | 通過 |

Pi 初次以預設 64,000 tokens 請求時，OpenRouter 回傳額度不足。依原生 Pi 模型設定，只降低此模型上限後重測成功；帳號憑證及其他模型設定未更換。此結果不保證任何帳號、模型或額度都可用。

## 修正與回歸

- Nginx 長網域 map 的 hash bucket 太小：調整後實際 Nginx 1.27.5 啟動驗證通過。
- 發行包缺少 supervisor：補齊，並從真正 npm 發行包解開後測試。
- 容器重啟後 PID 重用：只根據完整程序身份處理自有 supervisor，保留無關程序。
- 瀏覽器測試與 CSP 不相容：改用 locator 狀態斷言，保留正式環境 CSP。
- 服務商失敗訊息：固定分類碼，不回傳原始帳號資訊。
- 驗收工作區：僅封存該次新建且非 worktree 的工作區，確認封存結果並保留共享目錄。

最後映像部署後，設定頁再跑一輪 Claude／Codex／Pi，三者首輪與追問全部通過；每個新建驗收 agent 與 workspace 均確認封存成功。

實測部署組合：chart `0.5.8`；映像 tag `paseo-0.2.0-20261025-5cecb3797ad9`，digest `sha256:d866cb29de10dc8bd3502b01fcc92fb2f0ce2ccbea94228e302005a58fd4db66`。發行後新增的文件不影響此映像中的執行程式。

本機回歸：Node 22 與 Node 24 各通過 143 項插件測試及 3 項 CLI 映像測試；原生 OD 137 項、外掛卡片 9 項、chart/supervisor 12 項、實際 Nginx 6 項通過。插件及 Paseo runtime 兩份依賴稽核均為 0 個已知漏洞。這些測試數不等於長期負載或全部商業情境已驗收。

## 發布範圍與待完成項目

公開原始碼可下載；執行需要相容主機的原生 launcher、MCP API、代理路由、持久化目錄與監督程序。從一般 OD 匯入 Skill 並不會安裝這些後端能力。參考映像的 base registry 仍需要授權。

本次實測限已授權測試服務；未部署到另一個截圖服務。平台完整 Redeploy 仍跟隨舊商品範本，正式推廣前需要完成範本／版本政策整合。PaaS prerelease 版號解析修正已另備源碼與 190 項通過的測試，尚未部署；本次 chart 使用穩定版號避開該問題。

配對連結、瀏覽器登入狀態、帳號憑證及原始 logs 都只保留在私有證據目錄，不隨 repo 發布。
