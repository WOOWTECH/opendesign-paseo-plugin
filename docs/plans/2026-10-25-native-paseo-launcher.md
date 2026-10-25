# Native Paseo Launcher Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a native bundled Paseo card opening a protected setup page, with managed runtime, automatic onboarding and working Claude/Codex/Pi conversations.

**Architecture:** Follow the deployed MCP/console pattern. Bundled `woow-paseo` launches `/paseo/setup/`; a separately supervised loopback service serves it and `/api/paseo-bridge` through the existing authenticated proxy. Reuse bounded runtime and tenant credentials. Use native HTTP APIs for onboarding and atomic MCP registration. Keep the existing CLI image product.

**Tech Stack:** Node, Express, pinned Paseo runtime, native OD plugin contracts, Helm, Playwright.

1. Add bundled launcher and contract tests (Planck).
2. Add standalone bridge with installation validation, explicit data/home paths, once-only activation and shutdown; preserve manual stop.
3. Register only owned MCP entry through atomic native API. Reconcile onboarding ownership metadata.
4. Add optional reproducible image/chart packaging, proxy routes and readiness (Boole assists).
5. Run unit/HTTP/browser regressions. Preflight and back up the authorized test service before deploy.
6. Test native card, authentication, models, pairing, fresh two-turn chats, restart persistence and sibling launchers. Record exact limitations.
7. Publish reviewed code and deployment docs without private artifacts.

Screenshot service is a separate deployment; promotion scope is pending the user answer.
