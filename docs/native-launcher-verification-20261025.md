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

後續已部署至截圖中的服務 244，並保留原有 Omnigent。平台完整 Redeploy 仍跟隨舊商品範本，正式推廣前需要完成版本政策發布與實際 Redeploy 驗收。PaaS prerelease 版號解析修正已另備源碼與 190 項通過的測試，尚未部署；本次 chart 使用穩定版號避開該問題。

配對連結、瀏覽器登入狀態、帳號憑證及原始 logs 都只保留在私有證據目錄，不隨 repo 發布。

## 後續部署：服務 244 與手機入口

服務 244 從既有 Omnigent `f95a85bcd534` 主機衍生，沒有換成服務 10 的主機。
Paseo runtime、初始化對話、原生 MCP、設定頁及官方 App 配對已實測成功。
該服務尚未具備 Claude／Codex／Pi 的有效模型授權；模型清單不代表帳號已登入，
沒有將其他工作區的憑證複製過去，也沒有將它列為三模型對話已通過。

實測找到原生 marketplace 的手機 CSS 會隱藏所有「開啟」按鈕，列表與詳細頁皆受影響。
已在原生 TSX／CSS 修正，維持原有連結、同網域新分頁及其他外掛的響應式行為。
含 Omnigent 的來源 commit 為 `721f80835646d4d53ffc9e9d898aa54c965e3b64`；
一般主機回移版為 `2fef8017bba43aac3b94ffadbb8da15678016e83`。

- 含 Omnigent：56 項 component 測試、15 項 Chromium 測試通過。
- 一般主機：36 項 component 測試、15 項 Chromium 測試通過。
- 兩者 web／e2e typecheck、guard、production static build 均 exit 0。
- 五種測試寬度為 320、390、720、721、1440px。
- 服務 244 正式網址的四個外掛，列表及詳細頁共 40 次真實點按均成功。

部署時另找到 file-only tar 在 containerd overlay 解壓會失敗；已恢復上一個可用映像，
修正為明確包含父目錄項目的 layer，再於隔離 Pod 真正下載／解壓並逐一核對 764 個前端檔案。
兩個主機版本均通過此檢查。失敗的候選映像不列入下列部署指引或建置 profile。

服務 244 最終組合：chart `0.5.8`、revision `33`，映像
`paseo-omnigent-mobile-0.2.0-20261025-01d1f22de3ce@sha256:d2677bf76f4b44bc4b344d1e254d4da0f33361e3bf01db92762e1deb9ef41454`。
新容器全數 Ready 後才執行上述正式入口測試。
10:52 UTC 再驗官方 Paseo App 配對成功，主機身份匹配；桌面及手機四個入口可正常開啟，
三個匿名端點均為 401。Claude／Codex 顯示授權待確認，Pi 的空模型與登入引導正常，沒有執行未授權的模型登入。

服務 10 最終組合：chart `0.5.8`、revision `30`，映像
`paseo-mobile-0.2.0-20261025-8b9708a2b535@sha256:8dedab28b9471bc146383d3ca6f1811718b8aeb0190f1a0ab601b5f80b2cfa1c`。
三個原生外掛於上述五種尺寸的列表／詳細頁共 30 次實際點按通過。
兩個服務的原專案檔案（244：15，10：1,832）逐檔雜湊不變，初始化對話 ID 沿用，
原生 stdio MCP 的四個工具列出且 `paseo_status` 實際呼叫成功。

這一輪服務 10 的 Claude Code `claude-haiku-4-5` 與 Codex `gpt-6.1-sol` 首輪、追問均通過。
Pi 的 `openrouter/anthropic/claude-haiku-4.5` 回報 `PROVIDER_QUOTA_EXHAUSTED`，
原生 2,048-token 上限仍在，不能把先前成功紀錄當成本輪成功。帳號額度問題仍需處理。
接著在同一帳號，以當時模型清單提供的 `openrouter/cohere/north-mini-code:free` 做獨立驗收，
Pi 首輪與追問均通過；沒有更換帳密或修改原付費模型上限。免費模型成功不表示付費模型額度已恢復。

目前插件的 Node 22／24 回歸各為 148 項插件測試加 3 項 CLI 測試通過。

## 完整 Redeploy 政策：已實作，待平台發布

平台 PR1996 的 `f24d1dff3c2b6b108268c616ef74a97b7cd574aa` 新增管理員的單一服務部署固定設定，
包含原生表單、JSON 編輯與驗證；其他服務仍跟隨商品範本。已通過：

- 真正 Odoo／PostgreSQL 63 項，包含一般使用者首次開通、預設值注入防護、權限、重複 Redeploy 及錯誤回復。
- 39 項獨立 resolver 測試與 8 項 JSON parser 測試。
- 真正 Chromium 的 8 項 GUI 驗收：管理員編輯、無效 JSON 拒絕、儲存、reload、解除固定清空設定、租戶畫面不暴露管理員欄位。

這些測試沒有在正式平台執行完整 Redeploy。平台倉庫要求人工合併與建置批准；
發布後仍須依 [固定版本操作單](paas-service-pin-rollout.md) 完成 staging 與正式服務驗收。
因此目前不宣稱已達成全面商業上線。
