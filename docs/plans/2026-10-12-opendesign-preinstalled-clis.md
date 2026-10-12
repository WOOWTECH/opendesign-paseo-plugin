# OpenDesign Preinstalled CLI Image Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Remove the Paseo host plugin from the test OpenDesign deployment and ship Codex CLI, Claude Code CLI, and Pi CLI in the OpenDesign image by default.

**Architecture:** Build a pinned OpenDesign image that installs all three command-line clients globally during image build, with no Paseo host adapter or runtime preload. Reconfigure only the authorized cold-test service through its native PaaS deployment workflow, preserving its workspace data and existing authentication configuration.

**Tech Stack:** OpenDesign 0.24.1 Alpine image, Node.js/npm, pinned CLI npm packages, WoowTech PaaS native reconfiguration, Kubernetes StatefulSet, Chromium GUI.

---

### Task 1: Replace the Paseo runtime image with a preinstalled CLI image

**Files:**
- Modify: `image/Dockerfile`
- Modify: `image/entrypoint.sh`
- Modify: `image/README.md`
- Test: `tests/image-preinstalled-clis.test.mjs`

Pin Claude Code, Codex and Pi package versions. Install as root into the global PATH and verify each version under UID 1001. Keep the stock OpenDesign entrypoint and daemon command; remove the custom host-adapter installation and NODE_OPTIONS preload.

### Task 2: Update public product/install documentation

**Files:**
- Modify: `README.md`
- Modify: `open-design.json`
- Modify: `.github/workflows/verify.yml`
- Modify: `docs/validation.md`
- Create: `docs/preinstalled-cli-image.md`

Describe default availability, GUI discovery and first-use authentication. Retain private tenant credentials and distinguish CLI availability from successful provider authorization.

### Task 3: Build and validate the image

Build the actual OCI image, scan the image configuration and execute all three `--version` commands as UID 1001. Verify no Paseo package, host preload, recurring test conversation or startup installer is present. Push the immutable image to the WoowTech registry.

### Task 4: Replace the image on service254

Use the native PaaS reconfiguration/preflight/operator flow for service254 only. Remove its Paseo NODE_OPTIONS import, preserve HOME, OD_ALLOWED_ORIGINS, proxy authentication and persistent volumes, and deploy the new immutable image. Keep the previous image digest available for rollback.

### Task 5: Perform cold-start GUI acceptance

Verify the deployed service and all three commands from inside the running container. Use the normal authenticated OpenDesign GUI to perform Local AI discovery/rescan, confirm all three agents can be selected, and check restart behavior. Do not claim model chat acceptance unless an account is authorized for that provider.
