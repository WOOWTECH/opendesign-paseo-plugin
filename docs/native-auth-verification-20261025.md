# 原生登入修正驗證（2026-10-25）

本文件為匿名驗收摘要。主機位址、租戶與服務識別碼、帳號資訊、平台發布紀錄及完整操作證據留在部署者的私有紀錄中。

## 修正內容

- `386311b08af1dd41112fcaeafdda2d46cd62b0fb`：返回官方授權分頁後，使用新的受保護狀態查詢恢復同一次登入。隱藏時清除連結、裝置代碼及輸入；到期、關閉後不自動重啟。
- `b6e28bb88d393e1b4a3fd4573ae9e27d33f87a03`：從原生 Pi 執行檔找到 SDK，支援已驗證的 coding-agent 1.1.0／Pi AI 1.4.0；修正 import-only exports 無法由 CommonJS resolve 的問題。受管理 1.0.0／1.0.0 的修補驗證保留。
- 新增獨立 Chromium CI 工作，依賴缺失時失敗，不以 skip 當成功。

## 本機與隔離驗收

- Node 22／24：各 **175 項 launcher/runtime/browser 測試及 3 項 CLI 映像測試通過**，無 skip。
- 真實 Chromium native tab visibility：7 個情境，包含 Pi 回呼續接、Claude／Codex 完成確認、原始期限、401、在途回覆及顯式關閉；全部使用合成回應，沒有登入供應商。
- 11 項獨立 SDK 邊界測試涵蓋巢狀／hoisted 依賴、不同版本、錯誤 exports、symlink、損壞 manifest、managed repair bytes。
- 兩個候選映像都經真實 containerd 啟動，以非 root 使用者核對修正檔案並成功 import 官方 OAuth／AuthStorage；沒有建立帳號授權。

## 已授權的標準主機

透過原生 PaaS upgrade 更新相容映像。原專案檔案雜湊、持久卷身分及初始化對話保持不變；實際 stdio MCP 四個工具／status 成功。三個原生 launcher 在五種寬度的列表／詳細頁共 30 次點按通過。

使用該主機既有帳號，在設定 GUI 驗證：

| Provider | Model | 第一則／後續回覆 |
| --- | --- | --- |
| Claude | `claude-haiku-4-5` | 通過／通過 |
| Codex | `gpt-6.1-sol` | 通過／通過 |
| Pi | `openrouter/cohere/north-mini-code:free` | 通過／通過 |

前後 Pod 與映像身分一致。Pi 使用既有帳號的免費模型；這不代表其他付費模型額度充足。

## 含 Omnigent 的主機

透過原生 PaaS upgrade 更新相容映像並保留 Omnigent 0.1.5。所有容器就緒，原專案檔案、daemon、持久卷與初始化對話保留，實際 stdio MCP 工具／status 成功。

Pi 官方登入實際啟動，顯示官方連結與手動回呼輸入，再由 GUI 取消成功。前後帳號資料不變。桌面／手機四個原生入口、匿名三個受保護路徑 401、新的官方 Paseo 配對均通過；前後 Pod／映像身分一致。

此主機尚未完成 Claude／Codex／Pi 帳號授權，不能列為三種模型對話通過。本次只驗證官方授權能開始及取消，沒有複製其他工作區的帳號。

## 平台發布邊界

這些主機執行的是原生 upgrade，並未宣稱正式完整 Redeploy 已通過。[隔離原生 Redeploy 紀錄](native-redeploy-verification-20261025.md)記載完整 Odoo 測試與兩次真實 Helm／PVC 驗證。

平台部署政策仍須由平台維護者完成正式發布及目標主機驗收。[通用操作單](paas-service-pin-rollout.md)說明發布前條件。這個候選版不等於全面商業上線。
