# OpenDesign Paseo 插件

在 OpenDesign 原生 **Plugins / Integrations** 中安裝 Paseo，透過同一個受保護的 GUI 啟動服務、登入 Claude Code／Codex／Pi、選擇模型及模式，並配對官方 Paseo App。

## 使用者操作

由系統管理員先完成下方的主機整合。之後使用者只需：

1. 開啟 OpenDesign → Plugins → Import，貼上 `https://github.com/WOOWTECH/opendesign-paseo-plugin`。
2. 在 Paseo 插件卡片或 Integrations 開啟「安裝與連線設定」。首次安裝會啟動受控套件下載，並建立一個原生初始化對話。
3. 在設定頁查看三個代理的狀態，透過各供應商的官方流程登入自己的帳號。OpenDesign 管理員密碼只用於網站登入。
4. 選擇代理、模型與模式，執行「測試選定模型」。通過須取得本次兩輪實際回覆，並清理本次測試代理。
5. 按「建立配對連結」並開啟官方 Paseo App，在 App 中選擇同一台服務及模型開始對話。

手動停止會保存停用意圖，重新啟動 OpenDesign 後仍維持停止。Integrations 的 MCP 開關控制工具是否可用；服務的啟動／停止在 Paseo 設定頁操作。

## 管理員部署

OpenDesign 原生插件安裝器不會執行 npm 安裝或新增伺服器路由。本套件包含一個小型主機適配層，須先在受支援的 OpenDesign 容器中安裝一次。適配層沿用原生驗證、插件記錄、MCP 設定與專案 API，不另開公開連接埠。

目前相容性以 `host/compatibility.json` 的實際檔案 SHA-256 為準：OpenDesign 映像 0.24.1／內含 daemon 0.23.1，以及 WoowTech `20261012.0425-omnigent-v0.1.0` 自訂映像。兩個版本各自有完整的六檔指紋，安裝器會拒絕混合或未知版本。產品使用 Node.js 24；套件工具最低需要 Node.js 22.19。

在容器中，以產品使用者的身分執行：

```sh
npm ci --omit=dev
node scripts/install-host.mjs --home /home/opendesign --host-root /app
```

安裝器準備 HOME 持久卷下的不可變版本，驗證套件、主機指紋與覆寫內容，再發布版本指標。將輸出的 `nodeOptionsImport` 追加到服務原有的 `NODE_OPTIONS`，保留既有記憶體設定。例如：

```text
--max-old-space-size=4096 --import file:///home/opendesign/.local/share/opendesign-paseo/bin/preload.mjs
```

WoowTech PaaS 使用服務本身的 `config.extraConfig.NODE_OPTIONS` 配置，透過管理員的原生 ORM、全量配置組裝與 Operator 預檢／套用保存。沿用這台服務目前的 chart、映像與驗證設定，保留原 ENTRYPOINT、Omnigent 啟動鏈與產品參數；不要只修改正在執行的 Pod。若服務使用 Omnigent 自訂映像，應使用保留現行映像的配置流程：PaaS 的 Redeploy 會重新套用商品範本的映像，可能移除自訂整合。

`OD_DATA_DIR` 與 HOME 都需要可寫的持久卷。大型 runtime 與代理套件放在 `OD_DATA_DIR/paseo/packages`；各供應商登入資料留在使用者 HOME。需可連線至套件 registry、供應商授權服務與 Paseo relay，Python 3 用於經驗證的 Linux 鎖定 helper。

重啟並確認 OpenDesign 原功能正常後，再讓使用者從 Plugins 的 Git URL 安裝。配對連結及 OAuth 回呼只在保護頁面短暫使用，不放進對話、localStorage、Git 或一般日誌。

## 驗證與回復

```sh
npm ci
npm test
npm run check
npm audit --omit=dev
npm audit --omit=dev --prefix vendor/pi-paseo/runtime
```

瀏覽器測試需要 Python Playwright 與 Chromium。正式驗收工具讀取私密設定，預設只做唯讀檢查；變更功能須明確指定 `--allow-mutation`。使用 `node scripts/acceptance-config.mjs` 產生無憑證的設定樣板，填入已確認的專用測試目標、官方 App 選擇器與已登入代理，私密設定檔權限設為 `0600`。

更新保留前一版本，原生插件更換使用專用的暫存、發布與回復保護。回復前先停止 Paseo，還原已驗證的版本指標或移除該服務新增的 NODE_OPTIONS import，再以原生 PaaS 流程重新部署。保留 `OD_DATA_DIR/paseo` 與原產品資料；不要刪除租戶憑證或資料卷。

實測範圍與證據見 [docs/validation.md](docs/validation.md)。原始碼及鎖檔公開不代表每個租戶已完成供應商登入；三個代理都需要各自的帳號授權與可用額度。

## 來源

- [OpenDesign](https://github.com/nexu-io/open-design)
- [Paseo](https://github.com/getpaseo/paseo)
- [WOOWTECH Pi Paseo runtime](https://github.com/WOOWTECH/pi-paseo-plugin)：只沿用固定版本的受控 runtime，未執行 Pi Web 安裝器。

MIT 授權；來源版本見 `vendor/pi-paseo/PROVENANCE.json`。

Claude Code／Codex 完全不存在時的 GUI 下載驗證與前置條件：[cold-install-verification.md](docs/cold-install-verification.md)。
