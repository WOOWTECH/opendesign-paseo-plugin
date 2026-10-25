# PaaS 單一服務版本固定：發布後操作單

這是通用操作單。部署政策功能必須先在平台正式發布，才可執行；公開插件候選版本身不代表任一平台已支援固定版本。實際服務識別碼、映像與審批紀錄由部署者保管。

## 發布前條件

1. 平台必要 CI 與 Odoo 測試通過，依既有審閱、建置、核可與發布流程完成部署。
2. 在 staging 確認管理員原生表單出現部署政策、chart 版本與映像設定。
3. 確認一般租戶仍能開通服務，且看不到或寫入管理員欄位。
4. 重新讀取目標服務現有映像、插件組合、chart、revision 與備份。保留已授權的更新版本，不使用過期歷史目標覆蓋它。

## 管理員設定

只在指定服務的原生表單選擇固定版本，輸入已驗證的精確 chart 版本與不可變映像參照。例如：

```json
{
  "image": {
    "repository": "registry.example/team/open-design",
    "tag": "your-tested-tag@sha256:<64-character-lowercase-digest>"
  }
}
```

此範例不能直接部署。請以自己的 registry、已驗證 tag 及真實 SHA-256 取代，並確認映像保留該服務既有的 Omnigent 等功能。

保持 `paseo.enabled`、正確 HTTPS origin、儲存卷與帳號設定。不要修改共用商品範本來影響其他租戶。返回跟隨範本時，表單會清空固定值；解除固定前先確認商品範本支援現有功能。

## 完整 Redeploy 驗收

- 事前記錄 image digest、chart、revision、初始化對話、專案檔案雜湊及持久卷身分。
- 儲存設定後，實際按平台「完整重新部署」。
- 確認平台記錄、Helm 實際版本與所有容器就緒；確認映像／chart 未回到舊範本，原設定、資料與對話保留。
- 跑 `verify-responsive-launchers.py`；具備供應商授權時再跑 `verify-native-launcher.py --chat`。
- 再執行一次完整 Redeploy，確認結果一致；其他服務仍沿用原政策。
- 失敗時保留證據，透過原生流程恢復先前已驗證映像與 chart，不刪除 PVC 或更換帳密。

[隔離驗收紀錄](native-redeploy-verification-20261025.md)不能取代目標平台的上述驗收。尚未登入供應商的主機只能驗證入口、配對與登入引導，不能列為模型對話通過。
