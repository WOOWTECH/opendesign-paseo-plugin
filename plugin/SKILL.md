---
name: woowtech-paseo
description: Use when the user asks to set up Paseo in OpenDesign, connect the official app, log in to a provider, choose a model or mode, or verify a two-turn conversation.
---

# Paseo 安裝與連線設定

1. 引導使用者開啟目前 OpenDesign 網站的 [Paseo 設定頁](/paseo/setup)。在設定頁安裝並啟動服務、檢查帳號與模型、連接官方 App。服務停止後，使用者需再次啟動。
2. 帳號設定使用頁面的「登入與帳號設定」，在官方登入頁完成授權，再確認狀態。沒有可用登入流程時，明確說明尚未支援；工具存在、模型目錄或舊測試成功都不能證明目前帳號已授權。
3. 配對由使用者點擊「建立配對連結」，再到官方 App 完成。配對資訊只留在受保護的暫時畫面。建立連結不是配對成功證據。
4. 使用者從實際目錄選擇 provider、model、mode，再按「測試選定模型」。只有取得第一則與後續回覆才能報告兩輪測試成功。舊紀錄須附時間，並稱為上次測試。
5. 使用「開啟設定對話」回到既有初始化對話；延續同一對話，不為重試建立副本。可用時透過 woow-paseo 的去敏狀態、模型與聊天工具協助一般操作，以實際 tool schema 為準。

登入密碼、API 金鑰、OAuth 資訊與配對連結不可索取或貼入聊天、工具結果、檔案、紀錄或分享內容。使用官方授權流程；遇到缺少授權，說明待完成的步驟。

## 安裝界線

原生外掛 id 為 `woowtech-paseo`；MCP id 為 `woow-paseo`。預定公開來源為 `WOOWTECH/opendesign-paseo-plugin`，外掛檔案位於 `plugin` 子目錄；原生來源格式為 `github:WOOWTECH/opendesign-paseo-plugin/plugin`。發佈前不得宣稱來源已公開或可安裝。

主機管理員必須先安裝相容的 OpenDesign host adapter，才能提供受保護的設定頁與受控 runtime。Stock OpenDesign 單靠 Git 外掛匯入不能註冊伺服器 routes 或啟動 Paseo。原生描述檔沒有安裝 hook，也不執行下載腳本；在已整合的主機，由主機於原生安裝成功後啟動受控服務並重用初始化對話，解除安裝時停止受管服務。

原生「Use」只載入這份指引，不代表已安裝、啟動、登入、配對或通過測試。若設定頁不存在，回報缺少主機整合，請管理員先完成一次安裝；勿自行修改主機、擴張權限或操作其他服務。
