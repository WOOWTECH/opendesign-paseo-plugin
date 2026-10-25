# PaaS 單一服務版本固定：待發布後執行

這是待平台功能發布後的操作單，不代表目前正式 PaaS 已支援固定版本。
功能來源：平台 PR1996，已驗證 commit `f24d1dff3c2b6b108268c616ef74a97b7cd574aa`。
平台倉庫要求真人審閱／合併與 CI 建置批准；不可用暫時改寫線上程式取代發布。

## 發布前條件

1. PR 的必要 CI 全綠，真人審閱及合併。
2. 依平台既有 release train 建立正式版本、完成建置批准與部署。
3. 在 staging 確認管理員服務表單出現部署政策、chart 版本與映像設定。
4. 確認一般租戶仍能正常開通服務，且看不到或寫入上述管理員欄位。

## 管理員設定

在指定服務的原生管理表單選擇固定版本，chart 輸入 `0.5.8`，映像設定使用下列其中一組。
先檢查服務當前的主機種類及已驗證映像；不要將含 Omnigent 的主機換成一般主機。

一般 OpenDesign／Paseo：

```json
{
  "image": {
    "repository": "jcr-prod.woowtech.io/woow-paas-docker-local/open-design",
    "tag": "paseo-mobile-0.2.0-20261025-8b9708a2b535@sha256:8dedab28b9471bc146383d3ca6f1811718b8aeb0190f1a0ab601b5f80b2cfa1c"
  }
}
```

含 Omnigent 的 OpenDesign／Paseo：

```json
{
  "image": {
    "repository": "jcr-prod.woowtech.io/woow-paas-docker-local/open-design",
    "tag": "20261025.104554-omnigent-b3270069b935-candidate@sha256:07a7767f12962fe6c1defc80a0de36040082affae226524218d0cf83d7599e71"
  }
}
```

上面的 Omnigent 0.1.5 映像來自後續原生 Omnigent 發布，繼承本輪已驗證的 Paseo 映像與手機修正。
若服務已有更新的授權發布版本，應先驗證該版本，不可直接覆蓋成上述歷史版本。

保持原服務的 `paseo.enabled`、正確 HTTPS origin、儲存卷與帳號設定。設定只限指定服務，
不修改共用商品範本或其他租戶。返回跟隨範本時，表單會清空固定值；下一次完整 Redeploy
就會使用商品範本，因此解除固定前必須確認該範本也支援目前功能。

## 真正完整 Redeploy 驗收

- 事前記錄目前 image digest、chart、revision、初始化對話 ID、專案檔案雜湊及持久卷身分。
- 儲存上述設定後，實際按平台「完整重新部署」。
- 同時確認 PaaS 記錄、Helm 實際版本與所有容器的就緒狀態；單看 PaaS Running 不足以判定成功。
- 確認映像 digest／chart 未回到商品範本，Paseo 設定仍在、初始化對話沿用、原檔案雜湊未變。
- 跑 `verify-responsive-launchers.py`；具備各供應商授權的服務再跑 `verify-native-launcher.py --chat`。
- 再執行一次完整 Redeploy，確認結果一致；同商品其他服務仍沿用原政策。
- 任一步失敗，保留證據並透過原生部署流程恢復先前已驗證映像及 chart，不刪除 PVC 或更換帳密。

尚未登入 Claude／Codex／Pi 的服務只能驗證介面、配對與登入引導，不能列為模型對話通過。
