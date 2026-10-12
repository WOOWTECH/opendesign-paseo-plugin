# OpenDesign Paseo GUI Implementation Plan

**Goal:** Install, enable, connect, and operate Paseo through OpenDesign's native Plugins and Integrations plus a protected GUI; verify Claude Code, Codex and Pi model selection and two-turn chat on the authorized existing tenant.

**Architecture:** Native plugin distribution (`SKILL.md` + `open-design.json`) supplies the catalog/workflow. A narrow version-pinned OpenDesign host adapter registers same-origin protected routes and native setup entry points; a deterministic runtime manager owns Paseo lifecycle, persistent state and exactly one onboarding conversation. Native MCP config is merged rather than replaced. Existing OpenDesign projects and Omnigent stay on their original paths and launch chain.

**Tech Stack:** Node.js ESM, OpenDesign 0.24.1 compiled host, Paseo 0.11.2 hardened pinned lock, Linux process supervision, native MCP SDK, browser GUI and Playwright.

## Authorization and target

Scope: team implementation and real tests on one explicitly authorized existing OpenDesign service. Verify owner, workspace, namespace and release before every deployment. Provider login remains tenant-owned. Do not copy credentials from other services. Never publish credentials, pairing offers, auth logs or browser state.

## Shared contracts

- GUI: GET /paseo/setup, API GET/POST /api/paseo-bridge under existing authentication and strict same-origin guard.
- Manager interface: status(), enable(), disable(), models(provider), pair() (only protected GUI response), acceptance(), login(action,provider), ensureOnboarding(). Mutations serialize; reads independently bounded. Public DTO has version, phase, desiredEnabled, daemon readiness, provider diagnostics, onboarding URL/id, last verification dates, operation state; never credentials or raw exceptions.
- Paseo state: resolved OD_DATA_DIR/paseo; heavy runtime packages under OD_DATA_DIR/paseo/packages and immutable bridge code under persistent HOME/.local/share/opendesign-paseo. Provider homes remain the authorized HOME. Internal adapter may map PI_PASEO_* variables; products never show these details.
- Native MCP entry id woow-paseo, stdio node <immutable-source>/bin/mcp.mjs; preserve unrelated servers. Its on/off toggle controls tool availability; daemon stop is a separate action.
- Host registration takes a native onboarding callback, so runtime manager never guesses native database schema. Store known conversation id before fallible prompting. Reuse it across enable and restart.
- Package installation does not run arbitrary remote install scripts. GUI enable invokes controlled manager. Startup restore honors persisted manual stop.
- Exact methods/routes must be backed by current deployed host source; adapters fail closed on unsupported host fingerprints. Setup page added before SPA catch-all; no second public unauthenticated port.

## Task 1: Target baseline and reproducible host adapter (main)

Create scripts/install-host.mjs, host/adapter.mjs, tests/host.test.mjs. Capture nonsecret baseline: image, deployment spec, project/file hashes, provider binary presence, config hashes, existing auth boundary and startup path. Back up only affected settings/code before publish, privately. Tests must reject wrong host/version, cross-origin requests, oversized/invalid JSON, symlinks and secret-bearing errors. Implement reversible adapter placement/launch, native onboarding callback and plugin install/use reconciliation. Verify setup/API coexist with original app, and startup runs only the managed bridge.

## Task 2: Runtime lifecycle (runtime worker)

Create src/manager.mjs, src/auth-flow.mjs, bin/supervise.mjs, bin/mcp.mjs and tests/runtime*.test.mjs. Use vendor/pi-paseo runtime, NOT its Pi Web installer. Support Alpine safely: existing BusyBox flock lacks util-linux long options, so supply a verified compatible helper or vendor implementation with tests. Missing providers use pinned versions; repair Pi SDK dependency as necessary before invoking. Strip OpenDesign web secrets from child environment. Model/readiness must not equate CLI presence to account authorization. Persist enabled intent, keep owned processes only, restart crash recovery, manual pause, bounded operations, true first/followup responses, archive only owned acceptance agents. Native MCP exposes sanitized status/models/chat/continue, not pairing credentials.

## Task 3: Protected GUI and plugin bundle (GUI worker)

Create ui/setup.html, ui/setup.js, ui/setup.css, plugin/SKILL.md, plugin/open-design.json and tests/ui*.test.mjs. No dependencies for static UI. Traditional Chinese labels; install/start/stop, progress, diagnostics, three catalogs/modes, provider login guidance, pairing link in a protected transient section, open/reopen onboarding, true acceptance button. Pause overlapping mutation polling; bounded refresh; do not show historical chat/relay verification as live proof. No secrets in storage/query/logs. Pair via user click opens official Paseo. Source manifest anchored to native OD schema; no unrestricted permission defaults. Propose minimal source-aware native Plugins/Integrations entry patch to main; do not edit host adapter or runtime files.

## Task 4: Security and deployment review (advisor)

Review target-independent source boundaries, auth/origin/body/SSRF, ownership, data mounts, restore chain, rollback and Alpine compatibility. Exact actionable findings with test cases. No production mutations. After implementation, separate spec and quality checks; fix findings before deployment.

## Task 5: Integrated checks and authorized deployment (main)

Run meaningful unit/contract/security tests, syntax/package checks and dependency audit. Install from reviewable fixed source to the target, using reversible atomic host changes and existing startup management. Backups retain old launch/code and user state. Verify native Plugins import and Integrations entry through real GUI, not only API. Confirm no unrelated provider/plugin/project changes.

## Task 6: Real acceptance and recovery (main with test worker)

Browser: desktop/mobile, GUI enable/disable, provider diagnostics, actual catalogs, official relay pair, actual model/mode selection and chat. SDK: each selected provider initial response plus new followup; archive owned tests and retain transcripts. Crash owned Paseo daemon -> automatic recover; manual Stop -> stays stopped; OpenDesign restart -> restore same onboarding. Plugin update/repeat install -> one source and same state; failure -> old ready version or explicit recoverable state. Restore/retest native project/file baseline and Omnigent status. Authentication gaps require official tenant authorization through GUI; report them precisely without treating web admin password as provider login.

## Task 7: Distribution and evidence

Publish reproducible source and public install instructions under WOOWTECH after clean checks. Document tested versions, target, results, rollback, limitations and account-dependent checks. CI verifies contracts/package without production credentials. Keep confidential evidence outside Git. Completion requires fresh deployed health and real acceptance, not worker claims.
