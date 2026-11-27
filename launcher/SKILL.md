---
name: woow-paseo
description: Open Agent Connect in OpenDesign when the user wants to manage the underlying Paseo service, connect Paseo, Woowtech Smart or Apporo Smart, or check provider readiness.
---

# Agent Connect

在 OpenDesign「插件」頁找到「Agent Connect」，按「開啟」前往同源的 [/paseo/setup/](/paseo/setup/)。使用設定頁管理底層 Paseo 服務、帳號授權，並選擇 Paseo、Woowtech Smart 或 Apporo Smart 完成配對。

依設定頁的實際結果區分服務就緒、供應商授權與模型對話成功。CLI 或帳號檔存在、模型清單可讀、配對連結已產生，都不能單獨證明新對話或用戶端配對成功。若頁面沒有 Agent Connect 內容，回報主機整合尚未就緒。

帳號授權與配對資訊只在受保護的設定頁及官方授權流程中處理；不要將密碼、API key、OAuth 資料或配對連結放入聊天。

此入口的原生插件 ID 為 `woow-paseo`，由支援 `od.launch` 的主機映像註冊為 bundled。匯入此指引不會安裝或啟動 Paseo；主機提供設定頁與後端服務。
