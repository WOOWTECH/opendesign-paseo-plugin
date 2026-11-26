# OpenDesign Agent Connect Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Upgrade the optional OpenDesign Paseo integration to Agent Connect, then verify the same host through official Paseo, Woowtech Smart and Apporo Smart using official Paseo as the behavioral reference.

**Architecture:** Preserve the native OpenDesign launcher, existing `/paseo/` routes, plugin/MCP identities, provider homes and persistent daemon data. Migrate the managed CLI/SDK and compatibility adapters together; expose a reviewed fixed list of client targets while retaining private pairing material only in transient UI state. Use an isolated host and owned test projects for live acceptance; retain failed attempts and verify cleanup.

**Tech Stack:** Node.js 22/24, ES modules, Express, official `@getpaseo/cli` and SDK, OpenDesign native launcher/MCP API, Playwright, existing OCI/Helm tooling.

---

### Task 1: Record baseline and official contract

**Files:** Read `vendor/pi-paseo/runtime/package.json`, `vendor/pi-paseo/src/runtime*.mjs`, `src/runtime-client.mjs`, `src/manager.mjs`, `host/security.mjs`, `vendor/pi-paseo/PROVENANCE.json`.

1. Record immutable source SHA, current CLI/lock, launcher identities and existing release paths.
2. Read the tagged web session and fetch the three actual applications with a browser user agent; record their served build provenance and current official CLI/SDK contract.
3. Run the existing active tests before edits. Keep deprecated overlay tests identified separately by the repository test wiring.
4. Document the concrete API differences before selecting a new runtime; the Hermes-specific 0.11.2 restriction is not evidence of OpenDesign compatibility.

### Task 2: Implement explicit client targets and Agent Connect UI

**Files:** Modify `launcher/open-design.json`, `launcher/SKILL.md`, `ui/setup.html`, `ui/setup.js`, `host/security.mjs`, `host/adapter.mjs`; add focused target/pairing contract tests and register them in `scripts/check-test-wiring.mjs`.

1. Test official-default selection, each fixed HTTPS target, rejection of arbitrary origins/credentials/fragments, and pairing-link redaction for all three clients.
2. Add a shared target module where UI/server/DTO code need the same contract. Preserve existing native IDs and routes.
3. Rename visible navigation, headings and guidance to Agent Connect; distinguish the client target from the underlying Paseo daemon version.
4. Keep pairing links transient, clear on hide/navigation/target changes, and test stale-request races and failure states.

### Task 3: Upgrade the managed runtime and adapters together

**Files:** Modify `vendor/pi-paseo/runtime/package.json`, lockfile, affected vendored runtime modules, `vendor/pi-paseo/PROVENANCE.json`, `src/public-dto.mjs`, `src/runtime-client.mjs`, affected runtime tests.

1. Write or update contract tests for confirmed official API changes, including daemon readiness, providers/models, workspaces, agent turns and streaming/cancellation.
2. Generate the new exact lock with the same lifecycle-script restrictions; review changed dependencies and audit results.
3. Port the smallest compatibility changes while preserving locks, owned-process checks, manual stop state, credentials and existing conversation references.
4. Recompute only changed vendor hashes with an accurate patch explanation; run `npm run check:vendor`.

### Task 4: Validate an isolated real OpenDesign host

**Files:** Add acceptance harness/fixtures under `tests/` or `scripts/` only where reusable; private target/auth files remain outside Git. Sanitized evidence lives in the parent task directory.

1. Build the exact candidate using the established compatible host/layer mechanism; verify source/image/lock provenance before rollout to a disposable acceptance environment.
2. Verify native launcher, authenticated routes, anonymous denial, cold start, model catalog, owned lifecycle, restart persistence and same onboarding conversation.
3. Capture wide/narrow UI, dark-mode behavior where applicable, keyboard interaction, no overflow, no browser exceptions and safe error states.
4. Exercise real provider turns with short bounded prompts in owned test sessions using available authorized accounts. Record quota/auth failures as failures or blockers, never as passing conversations.

### Task 5: Compare three real web clients

**Targets:** `https://app.paseo.sh`, `https://smart.woowtech.io`, `https://smart.apporo.ai`.

1. Create separate browser contexts and disposable projects/workspaces per client. Pair each with the same isolated candidate host through the actual GUI.
2. Compare provider/model/mode controls, first/follow-up turns, streaming, stop, reconnection, refreshed history, file operations/attachments, approvals and applicable workspace/terminal/skills actions against the official client.
3. Test host stop/restart and browser reload without changing saved manual-stop intent or unrelated accounts/projects.
4. Record pass/fail/blocked/not-applicable per scenario, with official reference behavior and failed attempts retained. Verify owned cleanup and absence of credentials/pairing tokens in public evidence.

### Task 6: Align distribution and review

**Files:** Update only downstream package/image/chart provenance identified in the source audit; preserve unrelated feature branches and customer deployments.

1. Run active tests, extended supported tests, package/image contracts, test wiring, vendor provenance and required browser checks for the exact final commit.
2. Audit the resulting package, immutable image/lock and GitHub/Gitea source parity. Review the final diff and meaningful behavioral regressions.
3. Prepare concrete PR/release artifacts according to each repository's actual rules. Finish all test evidence before any genuine manual merge gate.
4. Report exact source/runtime/distribution versions and the real three-client acceptance matrix, including any remaining blockers.

Execution proceeds in this session under the user's existing authorization. Read-only protocol and deployment audits run in parallel; implementation and integration remain owned by the parent.
