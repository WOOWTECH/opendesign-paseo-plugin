# 原生 Redeploy 隔離驗證（2026-10-25）

## 測試範圍

- 平台候選程式通過完整 Odoo suite：**7,477 tests、0 failures、0 errors**，完整性與實際執行清單檢查通過。
- 另完成 **2/2 次真實原生 Redeploy**：全新合成 Odoo DB、獨立 operator、Helm 與真實 PVC，沒有模擬 Helm。
- 沙盒程式來源逐檔比對一致。完整提交、CI、映像與叢集識別資料保留在私有發布紀錄。
- 使用最小 synthetic chart；本次不代表正式 OpenDesign 主機的完整 Redeploy、GUI、OAuth 或模型對話均已驗收。

## 執行與結果

原生路徑為：

`Odoo action_redeploy → deployment resolver／values 組裝 → operator HTTP PATCH → Helm upgrade → PVC／Pod → 原生狀態 poll`

| 階段 | 商品範本 | 實際部署 | Helm revision |
| --- | --- | --- | --- |
| 基準安裝 | 舊 chart／image A | 舊 chart／image A | 1 |
| 第一次 Redeploy | 舊 chart／image A | pinned chart／image B | 2 |
| 範本改版後再次 Redeploy | 新 chart／image A | 仍為 pinned chart／image B | 3 |

映像均以不可變 digest 指定，兩次實際 imageID 符合指定目標。實際 Helm 命令皆帶 `--reset-values`、未帶 `--reuse-values`；舊 install-only value 消失，新 chart 預設生效。

每次均產生新的 Ready Pod，**PVC UID、volume、合成檔案 SHA-256 不變**。明確關閉的功能與其他設定保留；原生 poll 回到 running，驗證待辦清除且無錯誤。

## 隔離與限制

測試只使用專用 namespace，沒有複製正式租戶帳號或模型供應商憑證。Operator 權限限制在測試範圍，完成後清理測試 namespace 與所屬儲存資源。

測試權限無法讀取跨 namespace 的 Longhorn 容量資料，因此不宣稱已驗證該容量預檢。正式平台仍需既有發版流程、備份、staging 及目標服務完整 Redeploy 驗收。
