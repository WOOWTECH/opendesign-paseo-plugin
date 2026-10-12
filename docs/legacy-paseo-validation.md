> 歷史紀錄：以下結果屬於先前的 Paseo 插件部署，不代表目前 OpenDesign 預裝 CLI 映像仍安裝該插件。最新狀態請看 [預裝 CLI 映像驗收](preinstalled-cli-image.md)。

# 歷史驗證記錄：Paseo 插件（已退役）

日期：2026-10-12。指定的 WoowTech OpenDesign PaaS 服務已完成下列安裝、對話、安全邊界與回復驗證。Codex 尚待該租戶的官方帳號授權，因此以發布候選版狀態交付，不將三個代理都標示為對話驗收通過。

## 環境

OpenDesign 0.24.1、daemon 0.23.1、Node 24.21.0、Alpine 3.24，容器以 UID 1001 運行。使用既有 PaaS 服務與 HOME／data 持久卷，維持原 ENTRYPOINT、反向代理登入保護及 Omnigent 啟動鏈。適配層僅對 `host/compatibility.json` 中的完整六檔 SHA-256 profile 啟用；拒絕混合或未知檔案。此驗收不代表任意 OpenDesign 版本、任意映像或共享 HOME 都相容。

Paseo runtime 0.11.2；正式服務上的 Claude Code 2.1.284、Codex 0.162.1、Pi 1.0.0 版本查詢通過。可安裝或取得模型清單不等於供應商登入或模型對話通過。

## 指定環境結果

| 項目 | 結果 |
| --- | --- |
| 原生 Plugins 安裝 | 透過瀏覽器從公開 Git URL 執行原生 Import，下載並註冊插件，首次啟動只建立一次原生初始化對話 |
| 全新環境入口 | 設定頁提供「首次安裝連線插件」按鈕，透過原生安裝 API 解決歡迎頁因缺少 CLI 而不能進入 Plugins 的情況 |
| 原生入口 | Plugins 個人卡片與 Integrations 各一個設定入口，點擊可開啟設定頁及既有初始化聊天 |
| 瀏覽器與 RWD | 正式設定頁在 320、375、390、768 px 寬度沒有水平溢位；桌面／手機沒有頁面 JS 錯誤 |
| 登入邊界 | 未登入的 setup、bridge、MCP 請求回 401；已登入 setup／MCP 可用；供應商授權與配對資料不交給 MCP 工具或 Onboard 對話 |
| Claude 對話 | OD 設定頁與官方 Paseo App 均完成兩輪新回覆並封存測試 agent；模型 `claude-haiku-4-5`、mode `default` |
| Pi 對話 | OD 設定頁與官方 Paseo App 均完成兩輪新回覆並封存；模型 `openrouter/anthropic/claude-haiku-4.5`，不傳 mode |
| 模型清單 | production SDK、bridge 與瀏覽器設定頁相符：Claude 16/16、Codex 8/8、Pi 408/408；三個模型選取均通過，Pi 沒有 mode 選項 |
| Codex 對話 | 尚未驗證。工作區沒有 Codex 官方登入資料或 OpenAI API key；已安裝與可讀模型清單不算通過。等租戶使用者完成官方授權後再測 |
| 官方 App 配對 | 以獨立瀏覽器狀態配對；核對本次服務身份、公鑰與 relay，沒有把 OpenDesign Basic 登入帶到官方 App |
| MCP | 真實 MCP SDK stdio 連線，列出四個工具並呼叫 status；沒有提供登入或配對工具 |
| MCP 開關保存 | 在原生 Integrations 關閉 `woow-paseo`，重新啟動 OpenDesign 後依然關閉、Paseo 仍正常；再透過 GUI 還原原 enabled 值，peer MCP 設定完整保留 |
| 手動停止保存 | 設定頁停止 → 原生 PaaS Restart → 三次狀態取樣仍停止 → GUI 重新啟用；Onboard conversation ID 不變 |
| 故障回復 | 以 pidfd 對已驗證的唯一 Paseo Supervisor 發送一次 SIGKILL。17.4 秒後恢復，連續三次就緒；同一安裝、初始化對話不變，OD／Omnigent 程序身份保留 |
| 不完整更新回復 | 對同一插件 ID 的兩個原生 ZIP 替換都在 managed staging 回 HTTP 400。立即及 6 秒 reconcile 後，檔案、native record、lockfile、Paseo 狀態與 Onboard 均相同 |
| GUI 卸載／重裝 | 原生確認卸載後，Personal 卡片和 Integrations 入口移除、Paseo 停止；再從設定頁 Import 同一公開 Git URL，成功後兩個入口各恢復一個 |
| 重裝資料保留 | provider 憑證狀態、peer plugins／MCP、全部 project／conversation ID、peer lockfile、原 Onboard 訊息及初始化 project／conversation 均不變；own MCP 設定依原值還原 |
| 原產品資料 | 原有 1,199 個 project 檔案逐一核對 SHA-256；沒有遺失或改變 |

測試 agent 都是本次建立，逐一以新 assistant cursor 確認兩輪回覆並封存；官方 App 使用獨立、完成後已關閉的瀏覽器 context。完整截圖、Pod 識別、登入資訊與測試資料留在私密目錄，沒有打包公開。

## 模型清單修正

新鮮 SDK／bridge 比對曾發現 Pi catalog 408 個 ID 中 18 個 `openrouter/~…` alias 被 ID 驗證器濾除；Claude 16/16、Codex 8/8 相符。放行 `~` 並新增 DTO 測試及部署後，重新對照三個 provider，所有 IDs 完全相同，沒有缺項或額外項。

## 已修正的問題

1. Express `sendFile` 對隱藏 HOME 路徑的檔案解析失敗；設定頁資產改使用明確 UI root，所有資產回應正常。
2. Bridge 狀態回應曾將完成中的舊 operation snapshot 與新 daemon state 混合；在非同步狀態呼叫前固定操作快照。
3. Claude 長 context 方括號 model ID、Pi 空 mode 選項及 OpenRouter `~` alias 都需要被保留；已各自補上嚴格選取／DTO 測試。
4. PVC 重新掛載改變 device ID，導致已完成交易被誤判為損壞。完成交易只在 inode 相同且其餘驗證通過時接受 device remap；進行中交易仍完整檢查 identity，沒有手改 SQL、journal 或 receipt。

## 本地與冷啟動驗證

最終整合測試 243/243 通過、零略過；套件檢查包含 68 個 JavaScript 檔案與 62 個發布檔。OpenRouter alias DTO 定向測試 13/13 通過。GitHub Actions 對 alias 修正提交 `62a7ec0` 的 Node 22／24 工作均成功。正式依賴稽核只送出公開 npm 套件名與版本；153 個版本的公開 advisory 查詢為零命中，不含租戶路徑或憑證。

固定 digest 上游映像的冷啟動驗證確認 Claude Code／Codex 原本不存在，由 GUI Import 觸發套件下載。前置工具、provider login 與限制記載在 [cold-install-verification.md](cold-install-verification.md)。

## 效能與上線界線

外網 `/api/health` 五次樣本的前後中位數分別為 332 ms 與 590 ms。共享服務、網路和時段不同，不能據此宣稱效能提升；未做隔離負載測試或第三方滲透測試。正式商用前仍需完成 Codex 官方授權／雙輪實測，以及租戶自己的備份、配額與回復檢查。
