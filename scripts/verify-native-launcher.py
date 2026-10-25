#!/usr/bin/env python3
"""Verify the deployed native launcher with private credentials and real browser actions.

The private directory contains target.json ({base}) and browser-auth.json
({username,password}). Use --chat only when real provider conversations are
explicitly authorized. Pairing links and credentials are never written to proof.
"""
import argparse
import asyncio
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import time
from urllib.parse import urlsplit

from playwright.async_api import async_playwright


class CheckFailed(Exception):
    pass


def require(condition, code):
    if not condition:
        raise CheckFailed(code)


async def verify(args, proof):
    private = Path(args.private_dir).resolve()
    require(private.is_dir() and private.stat().st_mode & 0o077 == 0, 'PRIVATE_DIRECTORY_REQUIRED')
    target = json.loads((private / 'target.json').read_text())
    auth = json.loads((private / 'browser-auth.json').read_text())
    base = target['base'].rstrip('/')
    parsed = urlsplit(base)
    require(parsed.scheme == 'https' and not parsed.username and not parsed.password and not parsed.query and not parsed.fragment and parsed.path == '', 'INVALID_TARGET')
    proof['origin'] = base
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(headless=True, args=['--no-sandbox'])
        anon = await browser.new_context()
        proof['authentication'] = {}
        for route in ['/paseo/setup/', '/paseo/assets/setup.js', '/api/paseo-bridge']:
            response = await anon.request.get(base + route)
            proof['authentication'][route] = response.status
            require(response.status == 401, 'AUTH_BOUNDARY_FAILED')
        await anon.close()
        context = await browser.new_context(http_credentials={**auth, 'origin': base}, viewport={'width': 1440, 'height': 1000})
        page = await context.new_page()
        await page.goto(base + '/plugins', wait_until='domcontentloaded')
        await page.locator('section.plugin-marketplace .plugin-marketplace__switch button').first.click()
        await page.get_by_test_id('plugins-tab-installed').click()
        proof['nativeCards'] = {}
        for plugin, route in [('woow-cli-terminal', '/console/'), ('woow-mcp-server', '/mcp-admin/'), ('woow-paseo', '/paseo/setup/')]:
            card = page.get_by_test_id('plugins-card-' + plugin)
            await card.wait_for(state='visible', timeout=30000)
            link = card.locator('a[href="' + route + '"]')
            require(await link.count() == 1, 'NATIVE_LAUNCH_LINK_MISSING')
            require(await link.get_attribute('target') == '_blank', 'NEW_TAB_CONTRACT_FAILED')
            proof['nativeCards'][plugin] = {'href': route, 'newTab': True}
        async with page.expect_popup() as pending:
            await page.get_by_test_id('plugins-card-woow-paseo').locator('a[href="/paseo/setup/"]').click()
        setup = await pending.value
        await setup.wait_for_load_state('domcontentloaded')
        require(setup.url == base + '/paseo/setup/', 'SETUP_ORIGIN_FAILED')
        await setup.locator('h1').filter(has_text='Paseo 安裝與連線設定').wait_for()
        await setup.wait_for_function("!document.getElementById('refresh').disabled")
        await setup.screenshot(path=str(private / 'native-setup.png'), full_page=True)
        deadline = time.monotonic() + 360
        while True:
            current = await (await context.request.get(base + '/api/paseo-bridge')).json()
            if current.get('daemon', {}).get('reachable'):
                break
            require(time.monotonic() < deadline, 'RUNTIME_NOT_READY')
            await asyncio.sleep(2)
        proof['onboarding'] = {key: current.get('onboarding', {}).get(key) for key in ['projectId', 'conversationId', 'initialized', 'phase']}
        require(proof['onboarding']['initialized'] is True, 'ONBOARDING_NOT_READY')
        await setup.locator('#refresh').click()
        await setup.wait_for_function("!document.getElementById('models').disabled")
        proof['providers'] = {}
        for provider in ['claude', 'codex', 'pi']:
            await setup.locator('#provider').select_option(provider)
            await setup.locator('#models').click()
            await setup.wait_for_function("!document.getElementById('model').disabled", timeout=90000)
            model = await setup.locator('#model').input_value()
            mode = await setup.locator('#mode').input_value()
            row = {'modelCount': await setup.locator('#model option').count(), 'model': model, 'mode': mode}
            proof['providers'][provider] = row
            require(row['modelCount'] > 0 and model, 'MODEL_CATALOG_EMPTY')
            if args.chat:
                before = (await (await context.request.get(base + '/api/paseo-bridge')).json()).get('lastVerification', {}).get('checkedAt')
                await setup.locator('#acceptance').click()
                deadline = time.monotonic() + 660
                while True:
                    state = await (await context.request.get(base + '/api/paseo-bridge')).json()
                    report = state.get('lastVerification') or {}
                    if report.get('checkedAt') and report['checkedAt'] != before:
                        found = next((item for item in report.get('providers', []) if item.get('provider') == provider), None)
                        require(found is not None, 'CHAT_RESULT_PROVIDER_MISMATCH')
                        row['chat'] = {key: found.get(key) for key in ['passed', 'firstReply', 'followup', 'model', 'modeId', 'code']}
                        row['checkedAt'] = report['checkedAt']
                        break
                    operation = state.get('operation') or {}
                    require(operation.get('status') not in ['error', 'interrupted'], 'CHAT_OPERATION_FAILED')
                    require(time.monotonic() < deadline, 'CHAT_RESULT_TIMEOUT')
                    await asyncio.sleep(2)
                await setup.locator('#refresh').click()
                await setup.wait_for_function("!document.getElementById('provider').disabled", timeout=30000)
        proof['passed'] = all(row.get('chat', {}).get('passed', True) for row in proof['providers'].values())
        await setup.screenshot(path=str(private / 'native-setup-models.png'), full_page=True)
        await browser.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--private-dir', required=True)
    parser.add_argument('--chat', action='store_true')
    args = parser.parse_args()
    proof = {'checkedAt': datetime.now(timezone.utc).isoformat(), 'realChatsRequested': args.chat, 'passed': False}
    try:
        asyncio.run(verify(args, proof))
    except Exception as error:
        proof['code'] = str(error) if isinstance(error, CheckFailed) else 'BROWSER_CHECK_FAILED'
    output = Path(args.private_dir) / 'native-launcher-proof.json'
    with os.fdopen(os.open(output, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), 'w') as stream:
        json.dump(proof, stream, ensure_ascii=False, indent=2)
    print(json.dumps({'passed': proof['passed'], 'code': proof.get('code'), 'providerChecks': len(proof.get('providers', {}))}))
    raise SystemExit(0 if proof['passed'] else 1)


if __name__ == '__main__':
    main()
