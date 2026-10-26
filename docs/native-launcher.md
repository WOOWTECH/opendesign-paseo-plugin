# Native Paseo launcher

## Boundaries

The bundled `woow-paseo` plugin follows the native MCP Server and CLI Terminal launcher contract. `od.launch.path` opens `/paseo/setup/` in a new tab. The host provides the protected page and runtime. Importing a skill alone cannot install backend code.

The optional service listens only on `127.0.0.1:7460`. The existing authenticated proxy forwards `/paseo/setup`, `/paseo/setup/`, `/paseo/assets/` and `/api/paseo-bridge`. Its private `/healthz` is not exposed by ingress. HTTP authentication belongs to the existing proxy; provider login uses the tenant's own credential home.

The service runs alongside OD in the **same container**, under the existing init and an explicit supervisor. This preserves the process identity checks used by the runtime and stdio MCP tools. It does not import or patch OD's startup modules or inject scripts into the marketplace.

## Host configuration

Required inputs to `node bin/serve.mjs`:

| Variable | Meaning |
| --- | --- |
| `OPENDESIGN_PASEO_DATA_DIR` | Absolute resolved OD data root supplied by the host |
| `HOME` | Existing tenant home with provider credentials |
| `OPENDESIGN_PASEO_BUNDLED_PLUGIN` | Absolute directory of the packaged native `woow-paseo` plugin |
| `OPENDESIGN_PASEO_ORIGIN` | Exact HTTPS origin used by the authenticated GUI |
| `OPENDESIGN_PASEO_NATIVE_PORT` | Loopback OD daemon port, default `7457` |
| `OPENDESIGN_PASEO_PORT` | Private service port, default `7460` |
| `OPENDESIGN_PASEO_AUTO_ENABLE` | `1` enables once on first installation; saved manual stop remains authoritative |

The runtime verifies both bundled manifest and skill against the packaged copies. A modified/missing launcher fails closed.

## Native MCP API

The host must implement `PUT /api/mcp/servers/:id` with body `{server, expected}`. `expected` is the full previous entry or `null` for a new one; `server: null` removes exactly the expected entry. The native configuration write queue compares and updates atomically, returning `409` for a stale expectation. Existing disabled state is preserved. The bridge never writes a complete server list, and cannot use a different entry's identity.

Only the `woow-paseo` stdio entry is managed. Native tools expose readiness, model discovery, chat creation and continuation. Pairing URLs and provider login secrets are excluded from MCP tool responses.

## Reproducible feature image

The optional release is a separately named image built from an immutable compatible OD image. The source profile records its base digest and reviewed native source revision. The layer builder compiles the native TypeScript modules with a pinned compiler, installs the plugin's lock-pinned production dependencies with lifecycle scripts disabled, and packages the bundled launcher.

```sh
npm ci --ignore-scripts
node scripts/build-native-layer.mjs /absolute/new/build-directory
# Preserve the separately verified Omnigent 0.1.4 host image:
node scripts/build-native-layer.mjs /absolute/new/combined-build omnigent-0.1.4
# Use your authorized registry identity; never place credentials in commands.
crane append --platform linux/amd64 \
  --base '<baseImage from build.json>' \
  --new_layer /absolute/new/build-directory/native-paseo-layer.tar \
  --new_tag '<your registry>/<repository>:<unique feature tag>' \
  --set-base-image-annotations
```

The output receipt includes the selected profile, actual immutable host image, source, compiler, lockfile and layer hashes. Accepted profiles are:

| Profile | Host |
| --- | --- |
| `open-design-w2.4` (default) | Original reviewed host |
| `open-design-w2.4-mobile` | Same host with native mobile launcher actions fixed |
| `omnigent-0.1.4` | Original combined Omnigent host |
| `omnigent-0.1.4-mobile` | Same Omnigent host with native mobile launcher actions fixed |
| `omnigent-0.1.5` | Deployed Omnigent 0.1.5 host, including the mobile launcher fixes |

The Omnigent profiles preserve that host's server, SDK and bundled launchers. Its two existing MCP source modules are identical to the reviewed base; the third MCP module is additive. Mobile profiles add only a source-built static web export and its provenance manifest. Their base images have passed real containerd extraction and all 764 web-file hash comparisons. These profiles do not claim compatibility with other host releases.

The image retains the base ENTRYPOINT and user. A host chart must enable supervision and authenticated routes together. Disable the optional chart feature and restore the previously pinned image to roll back; keep the existing persistent data and home volumes.

The source is downloadable, but building against a private base registry requires that registry's access. This does not claim compatibility with arbitrary upstream OD releases.

## Verification and evidence

Unit and HTTP tests cover the actual native launch URL, private headers, origin/body validation, lifecycle persistence, MCP compare-and-swap, and recovery of an existing owned onboarding conversation. Dependency audits cover the plugin and managed Paseo lockfiles separately.

For authorized real browser checks, create a private directory (mode `0700`) containing `target.json` with `{ "base": "https://your-host.example" }` and `browser-auth.json` with the existing proxy credentials. Optional `target.json.models` maps `claude`, `codex`, and `pi` to exact IDs from that host's current catalogue. Keep both files out of Git. The harness uses locator assertions compatible with the production CSP; it does not require `unsafe-eval`.

```sh
python3 scripts/verify-native-launcher.py --private-dir /absolute/private-directory
# Runs real, potentially billable two-turn conversations for all three providers:
python3 scripts/verify-native-launcher.py --private-dir /absolute/private-directory --chat
# Targeted retry; keep failed-run evidence in a separate private directory:
python3 scripts/verify-native-launcher.py --private-dir /absolute/private-retry-directory --provider pi --chat
```

The browser must click the actual native card and observe its new tab. It checks anonymous access denial, sibling launcher links, onboarding identity, and model selectors. Chat evidence requires a new verification timestamp and both replies. An installed CLI, a credential file, a model list or a generated pairing link alone does not count as a successful conversation or completed official App pairing.

Live deployment and official App pairing results are recorded separately when executed. Historical evidence from the retired preload architecture is not evidence for this release.

## Provider output limits

An authenticated provider can still refuse a request because its requested output allowance exceeds the account's available credit. The setup page distinguishes billing failures from missing authentication. It never displays the provider's raw error or account details.

On the tested Pi 1.1.0 installation, the native `~/.pi/agent/models.json` supports a specific built-in model override:

```json
{
  "providers": {
    "openrouter": {
      "modelOverrides": {
        "anthropic/claude-haiku-4.5": { "maxTokens": 2048 }
      }
    }
  }
}
```

Merge this entry into an existing file rather than replacing other settings. It contains no credentials. `pi --list-models anthropic/claude-haiku-4.5` confirms the effective limit; newly created sessions load the native setting. This limit applies to this model's Pi conversations, and may truncate long output. The plugin does not silently set account budgets or apply this override to every installation.

## PaaS release boundary

Chart `0.5.8` provides the optional supervision and protected routes; `paseo.enabled` defaults to false. Enabling it requires a matching feature image and the exact external HTTPS origin. Use a stable chart version until the platform's prerelease version parser fix is deployed.

**Full Redeploy preserves a service-specific chart/image when the platform has deployed the administrator-only pinning feature and that service is explicitly pinned.** Services using the default template policy continue to follow their product template. The shared product template has not been promoted to this feature release.

The policy passed focused Odoo, resolver, parser and browser checks, a full 7,477-test Odoo suite and [two isolated native Redeploy runs](native-redeploy-verification-20261025.md). It has now been released on the tested production platform. Two designated hosts each completed two real calls to the native full Redeploy action, preserving their exact chart/image, persistent volumes, project files and onboarding conversation. An existing newer Omnigent host image was retained.

See the [production verification record](production-redeploy-verification-20261026.md) and [deployment checklist](paas-service-pin-rollout.md) for scope and remaining checks. Production actions were invoked through the native service method; saving the administrator form in an authenticated production browser remains unverified. Other platforms must deploy and verify this feature themselves before relying on pins.

## 手機與桌面入口驗收

部署後可用 `python3 scripts/verify-responsive-launchers.py --private-dir /absolute/private-dir`
驗證 320、390、720、721、1440px 的列表及詳細頁「開啟」。每一項都實際點按並驗證新分頁，
手機操作區至少 44×44px。需要 Python Playwright 與 Chromium。

私有目錄權限必須為 `0700`，包含 `target.json`（`{"base":"https://your-od.example","omnigent":true}`）
及 `browser-auth.json`（`username`、`password`）；未安裝 Omnigent 時省略 `omnigent`。
帳密檔請設為 `0600`，不要放進 repo。此腳本不執行模型登入或對話；結果寫入同目錄的
`responsive-launcher-proof.json`，不包含帳密或配對連結。模型對話另用 `verify-native-launcher.py --chat` 驗收。


## GUI 帳號連結

1. 在外掛頁開啟 **Paseo 設定**，按 **重新整理**。
2. 選擇 Claude Code、Codex 或 Pi，按 **登入與帳號設定**，再開啟官方登入頁。
3. Claude Code 依官方授權頁操作；Codex 在官方頁輸入此設定頁提供的裝置代碼。
   Pi 的網頁登入使用 OpenAI Codex OAuth；只有畫面要求時，將官方回呼網址或代碼貼回設定頁。
   Pi 的這個登入方式不會同時授權 OpenRouter 等其他供應商。
4. 返回設定分頁後，畫面會重新向已驗證的後端查詢同一次登入進度。
   離開分頁時會清除畫面上的連結、裝置代碼與輸入內容；已輸入但未提交的回呼需要重新貼上。
   已到期、取消或按「隱藏登入資訊」的流程不會自動重新開始。
5. 確認官方登入完成後，按 **讀取可用模型**、選擇模型與模式，再按 **測試選定模型**。
   第一則與後續回覆均成功，才能確認該帳號與所選模型可正常對話。

主機的 OpenDesign 登入與模型供應商授權是兩個步驟。請使用這個工作區自己的供應商帳號；
設定頁不收集供應商密碼。尚未登入的新工作區可以先驗證外掛入口與 Paseo 配對，不能視為模型對話已完成。


### 預裝 Pi 的登入 SDK

相容映像預裝的 Pi CLI 為 1.1.0、其 Pi AI SDK 為 1.4.0。登入服務會從實際 Pi 執行檔
找到對應套件，核對套件版本及 ESM provider export，再載入官方 OAuth 與 AuthStorage。
不會為了登入重新安裝或降級主機 CLI。既有受管理 Pi 1.0.0 仍需通過 SDK 修補檢查；
套件損壞或版本不在已驗證組合內時會拒絕載入。
