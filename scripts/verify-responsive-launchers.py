#!/usr/bin/env python3
"""Click deployed native launcher cards and detail actions at five viewport widths.

Read target.json ({base, omnigent?: bool}) and browser-auth.json from a private
directory. No provider login or chat is performed. Credentials, browser state,
page contents and pairing links are excluded from the evidence.
"""
import argparse
import asyncio
import base64
from datetime import datetime, timezone
import json
import os
import traceback
from pathlib import Path
from urllib.parse import urlsplit

from playwright.async_api import async_playwright, expect


class CheckFailed(Exception):
    pass


def require(value, code):
    if not value:
        raise CheckFailed(code)


async def verify(private, proof):
    require(private.is_dir() and private.stat().st_mode & 0o077 == 0, 'PRIVATE_DIRECTORY_REQUIRED')
    target = json.loads((private / 'target.json').read_text())
    auth = json.loads((private / 'browser-auth.json').read_text())
    base = target['base'].rstrip('/')
    parsed = urlsplit(base)
    require(parsed.scheme == 'https' and parsed.netloc and not parsed.username
            and not parsed.password and not parsed.query and not parsed.fragment
            and not parsed.path, 'INVALID_TARGET')
    credentials = {key: auth[key] for key in ['username', 'password']}
    cards = [('woow-cli-terminal', '/console/'), ('woow-mcp-server', '/mcp-admin/'),
             ('woow-paseo', '/paseo/setup/')]
    if target.get('omnigent'):
        cards.append(('woow-omnigent', '/settings/omnigent'))
    proof['origin'] = base
    basic = base64.b64encode((credentials['username'] + ':' + credentials['password']).encode()).decode()

    async def guard(route):
        request = route.request
        url = urlsplit(request.url)
        if url.scheme + '://' + url.netloc != base:
            headers = await request.all_headers()
            body = json.dumps(headers) + (request.post_data or '') + request.url
            if basic in body or (len(credentials['password']) >= 6 and credentials['password'] in body):
                proof['credentialGuardTrips'] += 1
            await route.abort()
        elif request.method not in ['GET', 'HEAD', 'OPTIONS']:
            await route.abort()
        else:
            await route.continue_()

    async with async_playwright() as pw:
        browser = await pw.chromium.launch(headless=True, args=['--no-sandbox'])
        try:
            for width in [320, 390, 720, 721, 1440]:
                proof['stage'] = str(width)
                context = await browser.new_context(
                    http_credentials={**credentials, 'origin': base},
                    viewport={'width': width, 'height': 1000},
                    is_mobile=width <= 720, has_touch=width <= 720, service_workers='block')
                await context.route('**/*', guard)
                page = await context.new_page()
                await page.goto(base + '/plugins', wait_until='domcontentloaded')
                await page.locator('section.plugin-marketplace .plugin-marketplace__switch button').first.click()
                await page.get_by_test_id('plugins-tab-installed').click()
                for plugin, destination in cards:
                    card = page.get_by_test_id('plugins-card-' + plugin)
                    await expect(card).to_be_visible(timeout=30000)
                    for location in ['list', 'detail']:
                        if location == 'detail':
                            await card.click()
                            link = page.get_by_test_id('plugin-detail-open')
                        else:
                            link = card.locator('a[href="' + destination + '"]')
                        proof['stage'] = f'{width}:{plugin}:{location}'
                        await expect(link).to_be_visible(timeout=30000)
                        require(await link.get_attribute('href') == destination, 'DESTINATION_MISMATCH')
                        require(await link.get_attribute('target') == '_blank', 'NEW_TAB_CONTRACT_FAILED')
                        require({'noopener', 'noreferrer'} <= set((await link.get_attribute('rel') or '').split()), 'LINK_PRIVACY_FAILED')
                        await link.scroll_into_view_if_needed()
                        box = await link.bounding_box()
                        require(box and box['x'] >= -2 and box['x'] + box['width'] <= width + 2, 'CLIPPED_ACTION')
                        if width <= 720:
                            require(box['height'] >= 44 and box['width'] >= 44, 'TOUCH_TARGET_TOO_SMALL')
                        require(await page.locator('html').evaluate('(el) => el.scrollWidth <= innerWidth + 2'), 'PAGE_OVERFLOW')
                        async with page.expect_popup(timeout=30000) as pending:
                            if width <= 720:
                                await link.tap()
                            else:
                                await link.click()
                        popup = await pending.value
                        await popup.wait_for_load_state('domcontentloaded', timeout=60000)
                        url = urlsplit(popup.url)
                        require(url.scheme + '://' + url.netloc == base and url.path.rstrip('/') == destination.rstrip('/'), 'POPUP_DESTINATION_MISMATCH')
                        await expect(popup.locator('body')).to_be_visible()
                        await popup.close()
                        proof['checks'].append({'width': width, 'plugin': plugin, 'location': location, 'clicked': True, 'newTab': True})
                        if location == 'detail':
                            proof['stage'] = f'{width}:{plugin}:return-to-list'
                            await page.locator('.plugin-suite-detail__back').click()
                            await expect(card).to_be_visible()
                await context.close()
                print(json.dumps({'width': width, 'completedChecks': len(proof['checks'])}), flush=True)
            require(proof['credentialGuardTrips'] == 0, 'CREDENTIAL_GUARD_TRIPPED')
            proof['passed'] = True
            proof['stage'] = 'completed'
        finally:
            await browser.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--private-dir', required=True)
    args = parser.parse_args()
    private = Path(args.private_dir).resolve()
    proof = {'checkedAt': datetime.now(timezone.utc).isoformat(), 'passed': False,
             'checks': [], 'credentialGuardTrips': 0}
    try:
        asyncio.run(verify(private, proof))
    except Exception as error:
        proof['code'] = str(error) if isinstance(error, CheckFailed) else 'BROWSER_CHECK_FAILED'
        proof['category'] = type(error).__name__
        # Source locations help diagnose navigation failures without retaining
        # exception messages, page contents or URLs that may contain credentials.
        proof['frames'] = [{'function': frame.name, 'line': frame.lineno}
                           for frame in traceback.extract_tb(error.__traceback__)
                           if frame.filename == __file__]
    with os.fdopen(os.open(private / 'responsive-launcher-proof.json', os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), 'w') as stream:
        json.dump(proof, stream, ensure_ascii=False, indent=2)
    print(json.dumps({'passed': proof['passed'], 'checks': len(proof['checks']), 'stage': proof.get('stage'), 'code': proof.get('code')}))
    raise SystemExit(0 if proof['passed'] else 1)


if __name__ == '__main__':
    main()
