# PaaS Redeploy and Service 244 Implementation Plan

**Goal:** Keep the native Paseo integration across a full PaaS Redeploy and deploy it to the requested OpenDesign service without removing its existing Omnigent integration.

**Architecture:** Extend the existing PaaS deployment resolver with administrator managed service pins. Ordinary services continue following their product template. Build the Paseo layer against each verified immutable host image and retain native authentication, storage, quota and lifecycle paths.

**Tech Stack:** Odoo 18, Python, Helm, OpenDesign TypeScript, Node.js, Playwright.

## 1. Establish deployment evidence

- Capture service 10 and 244 template, image, chart, revision and resource identities using native ORM and Kubernetes reads.
- Save private configuration backups and project file hashes outside Git.
- Check service 244's current Omnigent image, native MCP modules and launch contract before adding a layer. Preserve credentials and other plugin entries.
- Keep service 148, which shares the old product template, outside this rollout.

## 2. Add an administrator managed deployment pin

Platform files: `src/models/cloud_service.py`, native service form XML, focused model/security tests and a deployment policy helper if needed.

- Add a validated chart version and digest pinned image configuration under system administrator permissions.
- Resolve full Redeploy and missing release installation through the same policy. Resolve image refresh and post-deploy comparisons against that policy.
- Leave the default template behavior unchanged. Tenant settings must not select chart versions or modify administrator pins.
- Test default behavior, scoped overrides, invalid pins, tenant RPC denial, quota preservation and rollback compatibility.
- Build and deploy a source tracked platform release through its existing release process; verify the actual installed fields and code before enabling the policy.

## 3. Build service 244's compatible image

Files: `scripts/build-native-layer.mjs`, `image/native-source/profile.json` and a separate compatible profile if required; corresponding builder tests.

- Compare the three reviewed native MCP modules against the current 244 image source.
- Record the actual immutable base in the build receipt; reject unsupported profiles.
- Build with lockfiles, publish a unique digest pinned image and verify its configuration and required files.
- Preflight the native PaaS upgrade with chart 0.5.8, exact HTTPS origin and existing service secrets.
- Update only service 244; wait for all containers and native health before browser acceptance.

## 4. Prove the user flow

- Run `python3 scripts/verify-native-launcher.py --private-dir <private244> --chat`.
- Click the installed native Paseo card, test authenticated setup, model/mode selection, onboarding identity and two real turns for Claude, Codex and Pi.
- Pair a fresh official Paseo browser session and repeat provider selection and conversation checks.
- Verify MCP Server, CLI terminal and Omnigent remain available. Check baseline project file hashes and existing configuration entries.

## 5. Prove full Redeploy and publish evidence

- Enable scoped deployment pins only after platform verification.
- Execute the real native full Redeploy first for service 10, then 244; verify image, chart, data, pairing and onboarding persist.
- Repeat browser and provider checks after Redeploy, retaining timestamped private evidence.
- Update public installation and verification documentation with exact versions, results and any remaining limitations. Commit and push tested source; do not describe unexecuted tests as passing.

## Recovery

Use each service's recorded native Helm revision and saved platform values. Preserve its persistent volumes and credential home. Keep the original product template unchanged and remove a service pin only through the administrator policy after a compatible recovery target is established.
