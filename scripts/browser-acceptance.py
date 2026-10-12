#!/usr/bin/env python3
"""Parent-operated Playwright acceptance; status is the read-only default.

Run from this repository. Private target.json and browser-auth.json are read at
runtime, never copied into source. Optional acceptance-config.json supplies
signedInProviders, models/modes, selectors, native paths, recovery expectations,
and actual official App selectors/actions discovered by the parent.

Official config:
  official: {connected: CSS, targetDaemon: CSS, targetDaemonText: 'expected name',
    startUrl: 'https://app.paseo.sh/',
    selectors: {provider: CSS, model: CSS, mode: CSS, title: CSS, prompt: CSS,
                send: CSS, assistant: CSS, ownedTitle: CSS, archive: CSS, archived: CSS},
    actions: {pair: [steps], newAgent: [steps], provider: [steps],
              model: [steps], mode: [steps], create: [steps], archive: [steps]},
    selectionAssertions: {provider: CSS, model: CSS, mode: CSS}}
Steps are {action: 'click'|'fill'|'select'|'assert', selector: CSS,
           value: '{provider}'|'{model}'|'{mode}'|'{title}'|'{prompt}'|literal}.
No JavaScript from config is executed. Native selects need no selection actions.
Custom selectors require a visible selection assertion. Chat archives only after
the uniquely titled agent created in this invocation is visibly confirmed.

Phases separate prerequisites from billable/mutating checks. Recovery observes
parent-triggered recovery; it does not restart, signal, install, or deploy hosts.
The parent separately verifies the existing project/file hash baseline.
"""
import argparse
import asyncio
import hashlib
from datetime import datetime
import json
import os
from pathlib import Path
import re
import stat
import sys
import time
from urllib.parse import urlsplit, urlencode
import uuid

PRIVATE_ROOT = Path(os.environ.get('OPENDESIGN_PASEO_ACCEPTANCE_PRIVATE_ROOT', str(Path.home() / '.private' / 'opendesign-paseo')))
PROVIDERS = ('claude', 'codex', 'pi')
PLUGIN_ID = 'woowtech-paseo'
PHASES = ('status', 'models', 'native', 'install', 'enable', 'disable', 'pair', 'ui-chat', 'acceptance', 'mobile', 'recovery')
MUTATING = frozenset(('install', 'enable', 'disable', 'pair', 'ui-chat', 'acceptance'))
SETUP_SELECTORS = {
    'root': '#main', 'enable': '#enable', 'disable': '#disable',
    'provider': '#provider', 'model': '#model', 'mode': '#mode', 'models': '#models',
    'pair': '#pair', 'pairLink': '#pair-link', 'pairPanel': '#pair-panel',
    'acceptance': '#acceptance', 'result': '#test-result',
}
NATIVE_SELECTORS = {
    'pluginsTab': 'section.plugin-marketplace .plugin-marketplace__switch button:first-child',
    'installedTab': 'section.plugin-marketplace [data-testid="plugins-tab-installed"]',
    'importOpen': 'section.plugin-marketplace[aria-labelledby="plugin-marketplace-title"] .plugin-marketplace__create',
    'importInput': 'section.plugin-marketplace__create-panel[aria-labelledby="plugin-create-title"] .plugin-marketplace__url-import-row input',
    'importSubmit': 'section.plugin-marketplace__create-panel [data-testid="plugin-create-import-url"]',
    'pluginCard': f'section.plugin-marketplace article[data-testid="plugins-card-{PLUGIN_ID}"]',
    'integrationEntry': f'section.integrations-view[aria-labelledby="integrations-title"] [data-paseo-entry="{PLUGIN_ID}"] a[href="/paseo/setup"]',
}


class AcceptanceError(Exception):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def require(condition, code):
    if not condition:
        raise AcceptanceError(code)


def safe_code(error):
    return error.code if isinstance(error, AcceptanceError) and re.fullmatch(r'ACCEPTANCE_[A-Z0-9_]{1,70}', error.code) else 'ACCEPTANCE_FAILED'


class SafeParser(argparse.ArgumentParser):
    def error(self, message):
        raise AcceptanceError('ACCEPTANCE_INVALID_ARGUMENT')


def parse_args(argv=None):
    parser = SafeParser(description='Phased Playwright acceptance; private config only, read-only default.')
    parser.add_argument('--phase', choices=PHASES, default='status')
    parser.add_argument('--config', default=str(PRIVATE_ROOT / 'acceptance-config.json'))
    parser.add_argument('--evidence')
    parser.add_argument('--allow-mutation', action='store_true')
    args = parser.parse_args(argv)
    require(args.phase not in MUTATING or args.allow_mutation, 'ACCEPTANCE_MUTATION_NOT_ALLOWED')
    return args


def private_path(file, root=PRIVATE_ROOT):
    candidate = Path(os.path.abspath(file))
    require(Path(root).is_absolute(), 'ACCEPTANCE_PRIVATE_ROOT_REQUIRED')
    root = Path(os.path.abspath(root))
    require(candidate != root and candidate.is_relative_to(root), 'ACCEPTANCE_PRIVATE_PATH_REQUIRED')
    current = Path(candidate.anchor)
    for segment in candidate.parts[1:]:
        current /= segment
        require(not current.is_symlink(), 'ACCEPTANCE_UNSAFE_PATH')
    return candidate


def read_private_json(file, optional=False, root=PRIVATE_ROOT):
    candidate = private_path(file, root)
    try:
        meta = candidate.stat()
        require(stat.S_ISREG(meta.st_mode) and meta.st_size <= 1_000_000 and not meta.st_mode & 0o077, 'ACCEPTANCE_PRIVATE_FILE_PERMISSIONS')
        value = json.loads(candidate.read_text())
        require(isinstance(value, dict), 'ACCEPTANCE_INVALID_CONFIG')
        return value
    except FileNotFoundError:
        if optional:
            return {}
        raise AcceptanceError('ACCEPTANCE_PRIVATE_CONFIG_UNAVAILABLE') from None
    except AcceptanceError:
        raise
    except Exception:
        raise AcceptanceError('ACCEPTANCE_PRIVATE_CONFIG_UNAVAILABLE') from None


def write_private_json(file, value, root=PRIVATE_ROOT):
    candidate = private_path(file, root)
    candidate.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = candidate.with_name(candidate.name + '.' + uuid.uuid4().hex + '.tmp')
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as output:
        json.dump(value, output, indent=2)
        output.write('\n')
    os.replace(temporary, candidate)


def target_origin(target):
    try:
        url = urlsplit(target.get('base', ''))
        require(url.scheme == 'https' and url.hostname and not url.username and not url.password and not url.query and not url.fragment and url.path in ('', '/'), 'ACCEPTANCE_INVALID_TARGET')
        host = '[' + url.hostname + ']' if ':' in url.hostname else url.hostname
        return 'https://' + host + (':' + str(url.port) if url.port and url.port != 443 else '')
    except AcceptanceError:
        raise
    except Exception:
        raise AcceptanceError('ACCEPTANCE_INVALID_TARGET') from None


def authorized_target_matches(target, allowed):
    if not isinstance(target, dict) or not isinstance(allowed, dict):
        return False
    if any(type(allowed.get(key)) is not int or not 0 < allowed[key] <= 2**53 - 1 for key in ('workspaceId', 'serviceId')):
        return False
    if any(not isinstance(allowed.get(key), str) or not allowed[key] or allowed[key] != allowed[key].strip() or len(allowed[key]) > 128 for key in ('namespace', 'release')):
        return False
    try:
        base = allowed.get('baseOrigin')
        approved = urlsplit(base) if isinstance(base, str) else None
        if not approved or approved.scheme != 'https' or not approved.hostname or approved.username or approved.password or approved.path or approved.query or approved.fragment:
            return False
        # Canonical origin is exact; case, whitespace and redundant default ports are not normalized into authorization.
        host = '[' + approved.hostname + ']' if ':' in approved.hostname else approved.hostname
        origin = 'https://' + host + (':' + str(approved.port) if approved.port and approved.port != 443 else '')
        if base != origin or target_origin(target) != base:
            return False
    except Exception:
        return False
    return all(target.get(key) == allowed[key] and type(target.get(key)) is type(allowed[key]) for key in ('workspaceId', 'serviceId', 'namespace', 'release'))


def authorized_target(target, config):
    require(authorized_target_matches(target, config.get('authorizedTarget')), 'ACCEPTANCE_AUTHORIZED_TARGET_REQUIRED')


def signed_in_providers(config):
    selected = config.get('signedInProviders')
    require(isinstance(selected, list) and selected and all(isinstance(p, str) and p in PROVIDERS for p in selected) and len(set(selected)) == len(selected), 'ACCEPTANCE_SIGNED_IN_PROVIDERS_REQUIRED')
    return selected[:]


def catalog_selection(catalog, provider, model, mode):
    require(isinstance(catalog, dict) and catalog.get('provider') == provider and
            all(isinstance(catalog.get(key), list) and all(isinstance(row, dict) and
                isinstance(row.get('id'), str) and row['id'] for row in catalog[key])
                for key in ('models', 'modes')), 'ACCEPTANCE_CATALOG_SCHEMA')
    require(isinstance(model, str) and bool(model.strip()), 'ACCEPTANCE_EXPLICIT_UI_SELECTION_REQUIRED')
    require(any(row['id'] == model for row in catalog['models']), 'ACCEPTANCE_INVALID_MODEL')
    blank_mode = mode is None or isinstance(mode, str) and not mode.strip()
    if not catalog['modes']:
        default = catalog.get('defaultModeId')
        require(blank_mode and (default is None or isinstance(default, str) and not default.strip()), 'ACCEPTANCE_INVALID_MODE')
        return model, None
    require(not blank_mode, 'ACCEPTANCE_MODE_REQUIRED')
    require(isinstance(mode, str) and any(row['id'] == mode for row in catalog['modes']), 'ACCEPTANCE_INVALID_MODE')
    return model, mode


def can_mutate_request(method, url, *, origin, phase, allowed, body=None, target=None, authorized=None):
    if method in ('GET', 'HEAD', 'OPTIONS'):
        return True
    parsed = urlsplit(url)
    request_origin = parsed.scheme + '://' + parsed.netloc
    # The actual setup UI transports read-only catalogs as POST. Only the exact
    # validated read action is permitted without mutation authorization.
    if method == 'POST' and request_origin == origin and parsed.path == '/api/paseo-bridge' and phase in ('models', 'acceptance'):
        try:
            catalog = json.loads(body) if isinstance(body, str) and len(body) <= 2048 else None
            if isinstance(catalog, dict) and set(catalog) == {'action', 'provider'} and catalog['action'] == 'models' and catalog['provider'] in PROVIDERS:
                return True
        except Exception:
            pass
    if not allowed or phase not in MUTATING or not authorized_target_matches(target, authorized):
        return False
    if authorized['baseOrigin'] != origin:
        return False
    if request_origin == origin:
        return parsed.path == '/api/paseo-bridge' or (phase == 'install' and parsed.path.startswith('/api/plugins/'))
    return phase in ('pair', 'ui-chat') and request_origin == 'https://app.paseo.sh' and not parsed.username and not parsed.password


def unwrap_status(value):
    return value['status'] if isinstance(value.get('status'), dict) else value


def status_evidence(value):
    value = unwrap_status(value)
    require(isinstance(value.get('providers'), list) and isinstance(value.get('daemon'), dict), 'ACCEPTANCE_STATUS_SCHEMA')
    daemon = value['daemon']
    return {
        'phase': value.get('phase') if value.get('phase') in ('not_installed', 'installing', 'starting', 'running', 'stopped', 'disabled', 'error', 'restart_required') else 'unknown',
        'installed': value.get('installed') is True,
        'version': '0.11.2' if value.get('version') == '0.11.2' else None,
        'desiredEnabled': value.get('desiredEnabled') is True or value.get('enabled') is True,
        'ready': daemon.get('ready') is True,
        'running': daemon.get('running') is True,
        'reachable': daemon.get('reachable') is True,
        'providers': [{'provider': provider, 'present': any(p.get('provider') == provider for p in value['providers'])} for provider in PROVIDERS],
    }


def onboarding_id(value):
    value = unwrap_status(value)
    onboarding = value.get('onboarding') or {}
    return onboarding.get('id') or onboarding.get('conversationId') or value.get('onboardingId') or value.get('onboardingConversationId') or value.get('onboardingSessionId')


def verification_time(receipt):
    try:
        value = receipt.get('checkedAt')
        require(isinstance(value, str) and value.endswith('Z'), 'ACCEPTANCE_FRESH_RECEIPT_REQUIRED')
        return datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp()
    except AcceptanceError:
        raise
    except Exception:
        raise AcceptanceError('ACCEPTANCE_FRESH_RECEIPT_REQUIRED') from None


def plugin_records(value):
    """Recognize native record IDs; never serialize the native response."""
    if isinstance(value, list):
        return [row for row in value if isinstance(row, dict) and any(row.get(k) == PLUGIN_ID for k in ('id', 'name', 'slug')) or isinstance(row, dict) and isinstance(row.get('entry'), dict) and row['entry'].get('name') == PLUGIN_ID]
    if isinstance(value, dict):
        if any(value.get(key) == PLUGIN_ID for key in ('id', 'name', 'slug')):
            return [value]
        for key in ('plugins', 'userPlugins', 'installed', 'items', 'data'):
            if key in value:
                found = plugin_records(value[key])
                if found:
                    return found
    return []


class Harness:
    def __init__(self, args, config, target, auth):
        self.args, self.config, self.auth = args, config, auth
        self.target = target
        self.origin = target_origin(target)
        require(all(isinstance(auth.get(key), str) for key in ('username', 'password')), 'ACCEPTANCE_AUTH_CONFIG_REQUIRED')
        self.selectors = {**SETUP_SELECTORS, **config.get('selectors', {})}
        self.native = {**NATIVE_SELECTORS, **config.get('native', {}).get('selectors', {})}
        self.evidence = {'schemaVersion': 1, 'harness': 'playwright', 'phase': args.phase, 'pluginId': PLUGIN_ID, 'checkedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'mutationAllowed': args.allow_mutation, 'passed': False}
        self.secrets = [auth['password']]
        self.browser = self.context = self.page = self.official_context = None
        self.screenshot_dir = PRIVATE_ROOT / 'evidence' / ('browser-' + uuid.uuid4().hex)
        self.events = {'pageErrors': 0, 'blockedWrites': 0, 'blockedSockets': 0}

    async def guard(self, route):
        request = route.request
        try:
            permitted = can_mutate_request(request.method, request.url, origin=self.origin, phase=self.args.phase, allowed=self.args.allow_mutation, body=request.post_data, target=self.target, authorized=self.config.get('authorizedTarget'))
        except Exception:
            permitted = False
        if permitted:
            await route.continue_()
        else:
            self.events['blockedWrites'] += 1
            await route.abort('blockedbyclient')

    async def bridge(self, action='status', **params):
        response = await self.context.request.get(self.origin + '/api/paseo-bridge?' + urlencode({'action': action, **params}), timeout=180000, max_redirects=0)
        require(response.ok, 'ACCEPTANCE_BRIDGE_HTTP_FAILED')
        body = await response.body()
        require(len(body) <= 2_000_000, 'ACCEPTANCE_RESPONSE_TOO_LARGE')
        try:
            value = json.loads(body)
        except Exception:
            raise AcceptanceError('ACCEPTANCE_BRIDGE_JSON_FAILED') from None
        require(isinstance(value, dict) and value.get('ok') is not False and not value.get('error'), 'ACCEPTANCE_BRIDGE_REJECTED')
        return value

    async def guard_socket(self, socket):
        parsed = urlsplit(socket.url)
        declared = self.config.get('official', {}).get('websocketHosts', ['app.paseo.sh'])
        allowed = self.args.allow_mutation and authorized_target_matches(self.target, self.config.get('authorizedTarget')) and self.config['authorizedTarget']['baseOrigin'] == self.origin and self.args.phase in ('pair', 'ui-chat') and isinstance(declared, list) and parsed.scheme == 'wss' and parsed.hostname in declared and (parsed.hostname == 'paseo.sh' or parsed.hostname.endswith('.paseo.sh'))
        if allowed:
            socket.connect_to_server()
        else:
            self.events['blockedSockets'] += 1
            await socket.close(code=1008, reason='Acceptance phase does not permit this connection')

    async def setup(self):
        response = await self.page.goto(self.origin + '/paseo/setup', wait_until='domcontentloaded')
        require(response and response.ok, 'ACCEPTANCE_SETUP_HTTP_FAILED')
        await self.page.locator(self.selectors['root']).wait_for(state='visible')
        for provider in PROVIDERS:
            await self.page.locator('#provider-' + provider).wait_for(state='visible')

    async def status(self):
        anonymous = await self.browser.new_context()
        try:
            checks = []
            for route in ('/paseo/setup', '/api/paseo-bridge?action=status'):
                response = await anonymous.request.get(self.origin + route, max_redirects=0)
                checks.append(response.status in (401, 403))
            self.evidence['unauthenticatedDenied'] = all(checks)
            require(all(checks), 'ACCEPTANCE_AUTH_BOUNDARY_FAILED')
        finally:
            await anonymous.close()
        await self.setup()
        self.evidence['status'] = status_evidence(await self.bridge())
        require(all(row['present'] for row in self.evidence['status']['providers']), 'ACCEPTANCE_PROVIDER_DIAGNOSTICS_MISSING')
        self.evidence['setupVisible'] = True
        await self.screenshot(self.page, 'setup')

    async def screenshot(self, page, label):
        private_path(self.screenshot_dir / (label + '.png'))
        self.screenshot_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        # Mask all input values, auth/pair panels, code, QR graphics and chat text.
        # Known secrets and authorization-shaped leaf text are additionally masked.
        # Compare secrets in the harness process. Never pass OpenDesign credentials
        # to JavaScript running inside the official App (or any page context).
        candidates = await page.evaluate('''() => {
          document.querySelectorAll('[data-acceptance-secret],[data-acceptance-scan]').forEach(e => {
            e.removeAttribute('data-acceptance-secret'); e.removeAttribute('data-acceptance-scan');
          });
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
          const parents = new Map(), texts = []; let total = 0;
          while (walker.nextNode()) {
            const node = walker.currentNode, text = node.textContent || '', parent = node.parentElement;
            if (!parent) continue;
            total += text.length;
            if (total > 2000000 || texts.length > 20000) throw new Error('MASK_SCAN_LIMIT');
            if (!parents.has(parent)) {
              const id = texts.length; parents.set(parent, id); texts.push('');
              parent.setAttribute('data-acceptance-scan', String(id));
            }
            texts[parents.get(parent)] += text;
          }
          return texts;
        }''')
        patterns = (
            r'https?://app\.paseo\.sh/\S*',
            r'(?:password|api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|bearer)\s*[=:]',
            r'sk-[A-Za-z0-9_-]{16,}',
            r'https?://\S*[?#].*(?:token|key|secret|code|state|ticket|pair|session)=',
        )
        masked = [index for index, text in enumerate(candidates) if any(secret and secret in text for secret in self.secrets) or any(re.search(pattern, text, re.I) for pattern in patterns)]
        await page.evaluate('''indices => {
          for (const index of indices) document.querySelector('[data-acceptance-scan="' + index + '"]')?.setAttribute('data-acceptance-secret', 'true');
        }''', masked)
        mask = page.locator('input,textarea,pre,code,img,canvas,svg,#pair-panel,#login-panel,[data-sensitive],[data-acceptance-secret]')
        assistant = self.config.get('official', {}).get('selectors', {}).get('assistant')
        masks = [mask]
        if assistant:
            masks.append(page.locator(assistant))
        destination = self.screenshot_dir / (label + '.png')
        # No trace, HAR, request/response log, console text, URL or unmasked fallback.
        fd = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        os.close(fd)
        try:
            await page.screenshot(path=str(destination), full_page=True, mask=masks, mask_color='#161616')
        except Exception:
            destination.unlink(missing_ok=True)
            raise AcceptanceError('ACCEPTANCE_SCREENSHOT_FAILED') from None
        self.evidence.setdefault('screenshots', []).append({'name': label, 'masked': True})

    async def setup_catalog(self, provider):
        await self.page.locator(self.selectors['provider']).select_option(provider)
        def catalog_response(response):
            if urlsplit(response.url).path != '/api/paseo-bridge' or response.request.method != 'POST':
                return False
            try:
                request = json.loads(response.request.post_data or '{}')
                return request.get('action') == 'models' and request.get('provider') == provider
            except Exception:
                return False
        async with self.page.expect_response(catalog_response, timeout=180000) as pending:
            await self.page.locator(self.selectors['models']).click()
        response = await pending.value
        require(response.ok, 'ACCEPTANCE_CATALOG_HTTP_FAILED')
        value = await response.json()
        require(isinstance(value, dict), 'ACCEPTANCE_CATALOG_SCHEMA')
        return value.get('catalog', value)

    async def no_mode_control(self, page, selector, *, allow_absent=False):
        require(isinstance(selector, str) and selector, 'ACCEPTANCE_MODE_SELECTOR_REQUIRED')
        locator = page.locator(selector)
        if allow_absent and await locator.count() == 0:
            return
        require(await locator.is_disabled() and await locator.input_value() == '' and
                not await page.locator(selector + ' option').evaluate_all('(nodes) => nodes.map(n => n.value).filter(Boolean)'),
                'ACCEPTANCE_MODE_UI_MISMATCH')

    async def setup_mode(self, mode):
        if mode is None:
            await self.no_mode_control(self.page, self.selectors['mode'])
        else:
            await self.page.locator(self.selectors['mode']).select_option(mode)
            require(await self.page.locator(self.selectors['mode']).input_value() == mode, 'ACCEPTANCE_MODE_UI_MISMATCH')

    async def models(self):
        await self.setup()
        rows = []
        for provider in PROVIDERS:
            row = {'provider': provider, 'passed': False}
            try:
                catalog = await self.setup_catalog(provider)
                require(isinstance(catalog, dict) and catalog.get('provider') == provider and isinstance(catalog.get('models'), list), 'ACCEPTANCE_CATALOG_SCHEMA')
                row['modelCount'] = len(catalog['models'])
                row['modeCount'] = len(catalog.get('modes') or [])
                require(row['modelCount'] > 0, 'ACCEPTANCE_CATALOG_EMPTY')
                await self.page.wait_for_function('''args => {
                  const options = [...document.querySelectorAll(args.selector + ' option')].map(n => n.value).filter(Boolean);
                  return options.length === args.ids.length && options.every((id, index) => id === args.ids[index]);
                }''', arg={'selector': self.selectors['model'], 'ids': [entry['id'] for entry in catalog['models'][:2000]]})
                available = await self.page.locator(self.selectors['model'] + ' option').evaluate_all('(nodes) => nodes.map(n => n.value).filter(Boolean)')
                require(set(available) == {entry['id'] for entry in catalog['models'][:2000]}, 'ACCEPTANCE_CATALOG_UI_MISMATCH')
                selected = self.config.get('models', {}).get(provider) or next((m['id'] for m in catalog['models'] if m.get('isDefault')), catalog['models'][0]['id'])
                configured_mode = self.config.get('modes', {}).get(provider)
                mode = catalog.get('defaultModeId') if configured_mode is None or configured_mode == '' else configured_mode
                selected, mode = catalog_selection(catalog, provider, selected, mode)
                await self.page.locator(self.selectors['model']).select_option(selected)
                await self.setup_mode(mode)
                row['selectionConfirmed'] = await self.page.locator(self.selectors['model']).input_value() == selected
                row['passed'] = row['selectionConfirmed']
            except Exception as error:
                row['code'] = safe_code(error)
            rows.append(row)
        self.evidence['providers'] = rows
        require(all(row['passed'] for row in rows), 'ACCEPTANCE_THREE_CATALOGS_REQUIRED')
        await self.screenshot(self.page, 'catalogs')

    def native_path(self, name, default):
        value = self.config.get('native', {}).get(name, default)
        require(isinstance(value, str) and value.startswith('/') and not value.startswith('//') and '#' not in value and '?' not in value, 'ACCEPTANCE_INVALID_NATIVE_PATH')
        return self.origin + value

    async def native_get(self, allow_absent=False):
        response = await self.context.request.get(self.native_path('pluginApi', '/api/plugins/' + PLUGIN_ID), max_redirects=0)
        if allow_absent and response.status == 404:
            return None
        require(response.ok, 'ACCEPTANCE_NATIVE_PLUGIN_HTTP_FAILED')
        value = await response.json()
        rows = plugin_records(value)
        require(len(rows) == 1, 'ACCEPTANCE_NATIVE_PLUGIN_NOT_UNIQUE')
        require(rows[0].get('manifest', {}).get('name') == PLUGIN_ID and self.owns_source(rows[0].get('source')), 'ACCEPTANCE_NATIVE_PLUGIN_SOURCE_MISMATCH')
        return rows[0]

    @staticmethod
    def owns_source(source):
        return isinstance(source, str) and re.fullmatch(r'(?:github:WOOWTECH/opendesign-paseo-plugin(?:@[A-Za-z0-9._-]+)?(?:/plugin)?|https://github\.com/WOOWTECH/opendesign-paseo-plugin(?:\.git)?/?(?:tree/[A-Za-z0-9._-]+/plugin)?)', source) is not None

    async def native_check(self):
        await self.native_get()
        self.evidence['nativePluginConfirmed'] = True
        await self.page.goto(self.native_path('pluginsPath', '/plugins'), wait_until='domcontentloaded')
        # Pinned native shell resets to Expert suites / OpenDesign official.
        # Imported records, including od.kind=skill plugins, live in Personal.
        await self.page.locator(self.native['pluginsTab']).click()
        await self.page.locator(self.native['installedTab']).click()
        try:
            await self.page.locator(self.native['pluginCard']).first.wait_for(state='visible')
        except Exception:
            raise AcceptanceError('ACCEPTANCE_NATIVE_CARD_NOT_VISIBLE') from None
        self.evidence['nativePluginCardVisible'] = True
        await self.screenshot(self.page, 'native-plugins')
        await self.page.goto(self.native_path('integrationsPath', '/integrations'), wait_until='domcontentloaded')
        entry = self.page.locator(self.native['integrationEntry'])
        try:
            await entry.first.wait_for(state='visible')
        except Exception:
            raise AcceptanceError('ACCEPTANCE_INTEGRATION_ENTRY_NOT_VISIBLE') from None
        require(await entry.count() == 1, 'ACCEPTANCE_INTEGRATION_NOT_UNIQUE')
        await self.screenshot(self.page, 'native-integrations')
        await entry.click()
        await self.page.locator(self.selectors['root']).wait_for(state='visible')
        require(urlsplit(self.page.url).path == '/paseo/setup', 'ACCEPTANCE_INTEGRATION_WRONG_ROUTE')
        self.evidence['nativePluginConfirmed'] = True
        self.evidence['integrationEntryConfirmed'] = True

    async def install(self):
        initial = unwrap_status(await self.bridge())
        original_onboarding = onboarding_id(initial)
        source = self.config.get('native', {}).get('gitUrl', 'https://github.com/WOOWTECH/opendesign-paseo-plugin')
        url = urlsplit(source)
        require(url.scheme == 'https' and url.hostname == 'github.com' and not url.query and not url.fragment and not url.username and not url.password and url.path.rstrip('/').removesuffix('.git') == '/WOOWTECH/opendesign-paseo-plugin', 'ACCEPTANCE_INVALID_PLUGIN_SOURCE')
        existing = await self.native_get(allow_absent=True)
        self.evidence['nativeInstallReused'] = existing is not None
        self.evidence['gitUrlImportConfirmed'] = False
        if existing is None:
            await self.page.goto(self.native_path('pluginsPath', '/plugins'), wait_until='domcontentloaded')
            await self.page.locator(self.native['pluginsTab']).click()
            await self.page.locator(self.native['importOpen']).click()
            await self.page.locator(self.native['importInput']).fill(source)
            async with self.page.expect_response(lambda r: urlsplit(r.url).path == '/api/plugins/install' and r.request.method == 'POST', timeout=360000) as pending:
                await self.page.locator(self.native['importSubmit']).click()
            response = await pending.value
            require(response.ok, 'ACCEPTANCE_NATIVE_IMPORT_FAILED')
            await asyncio.wait_for(response.finished(), timeout=360)
            await self.native_get()  # Native GET proof, independent of POST success.
            self.evidence['gitUrlImportConfirmed'] = True
        await self.native_check()
        expected_enabled = self.config.get('native', {}).get('expectedEnabled', initial.get('desiredEnabled') is True if existing is not None else True)
        require(isinstance(expected_enabled, bool), 'ACCEPTANCE_INVALID_NATIVE_EXPECTATION')
        after = await self.wait_state(expected_enabled)
        require(not original_onboarding or onboarding_id(after) == original_onboarding, 'ACCEPTANCE_ONBOARDING_CHANGED')
        self.evidence['managedRuntimeEnabledAfterNativeRecord'] = expected_enabled
        self.evidence['repeatInstallPreservedOnboarding'] = bool(original_onboarding) and onboarding_id(after) == original_onboarding

    async def wait_state(self, enabled):
        deadline = time.monotonic() + min(max(float(self.config.get('lifecycleTimeoutSeconds', 360)), 10), 600)
        while time.monotonic() < deadline:
            value = await self.bridge()
            row = status_evidence(value)
            if (enabled and row['desiredEnabled'] and row['ready'] and row['running'] and row['reachable']) or (not enabled and not row['desiredEnabled'] and not row['running'] and not row['reachable']):
                return value
            await asyncio.sleep(2)
        raise AcceptanceError('ACCEPTANCE_LIFECYCLE_TIMEOUT')

    async def toggle(self, enabled):
        await self.setup()
        before = onboarding_id(await self.bridge())
        await self.page.locator(self.selectors['enable' if enabled else 'disable']).click()
        value = await self.wait_state(enabled)
        after = onboarding_id(value)
        require(not before or after == before, 'ACCEPTANCE_ONBOARDING_CHANGED')
        self.evidence['sameOnboarding'] = bool(before) and before == after
        self.evidence['status'] = status_evidence(value)
        if not enabled:
            await asyncio.sleep(min(max(float(self.config.get('stopHoldSeconds', 20)), 1), 60))
            row = status_evidence(await self.bridge())
            require(not row['desiredEnabled'] and not row['running'] and not row['reachable'], 'ACCEPTANCE_MANUAL_STOP_NOT_PERSISTENT')
            self.evidence['manualStopHeld'] = True
        await self.screenshot(self.page, 'enabled' if enabled else 'disabled')

    async def steps(self, page, steps, values):
        require(isinstance(steps, list), 'ACCEPTANCE_UI_ACTIONS_REQUIRED')
        for step in steps:
            require(isinstance(step, dict) and step.get('action') in ('click', 'fill', 'select', 'assert') and isinstance(step.get('selector'), str), 'ACCEPTANCE_INVALID_UI_ACTION')
            selector = step['selector']
            value = step.get('value', '')
            require(isinstance(value, str), 'ACCEPTANCE_INVALID_UI_ACTION')
            for key, replacement in values.items():
                selector = selector.replace('{' + key + '}', replacement)
                value = value.replace('{' + key + '}', replacement)
            locator = page.locator(selector)
            if step['action'] == 'click':
                await locator.click()
            elif step['action'] == 'fill':
                await locator.fill(value)
            elif step['action'] == 'select':
                await locator.select_option(value)
            else:
                await locator.wait_for(state='visible')
                if value:
                    require(value in await locator.inner_text(), 'ACCEPTANCE_UI_ASSERTION_FAILED')

    async def pair(self):
        official = self.config.get('official', {})
        require(isinstance(official.get('connected'), str) and official['connected'], 'ACCEPTANCE_OFFICIAL_CONNECTION_SELECTOR_REQUIRED')
        require(isinstance(official.get('targetDaemon'), str) and isinstance(official.get('targetDaemonText'), str) and official['targetDaemonText'], 'ACCEPTANCE_OFFICIAL_TARGET_SELECTOR_REQUIRED')
        await self.setup()
        await self.page.locator(self.selectors['pair']).click()
        link = self.page.locator(self.selectors['pairLink'])
        await link.wait_for(state='visible')
        pairing_url = await link.get_attribute('href')
        parsed = urlsplit(pairing_url or '')
        require(parsed.scheme == 'https' and parsed.hostname == 'app.paseo.sh' and not parsed.username and not parsed.password, 'ACCEPTANCE_PAIR_ORIGIN_INVALID')
        self.secrets.append(pairing_url)
        await self.screenshot(self.page, 'protected-pair')
        self.official_context = await self.browser.new_context(viewport={'width':1440,'height':1000},service_workers='block')
        await self.official_context.route('**/*', self.guard)
        await self.official_context.route_web_socket('**/*', self.guard_socket)
        official_page = await self.official_context.new_page()
        official_page.on('pageerror', lambda _: self.events.__setitem__('pageErrors', self.events['pageErrors'] + 1))
        await official_page.goto(pairing_url, wait_until='domcontentloaded', timeout=60000)
        require(urlsplit(official_page.url).netloc == 'app.paseo.sh', 'ACCEPTANCE_OFFICIAL_APP_ORIGIN_INVALID')
        if official.get('actions', {}).get('pair'):
            await self.steps(official_page, official['actions']['pair'], {'pairingUrl':pairing_url})
        await official_page.locator(official['connected']).wait_for(state='visible', timeout=90000)
        await self.confirm_official_target(official_page, official)
        self.evidence['protectedPairLink'] = True
        self.evidence['officialAppConnected'] = True
        # Browser state contains credentials and is private, never an evidence artifact.
        state = await self.official_context.storage_state()
        write_private_json(PRIVATE_ROOT / 'official-browser-state.json', state)
        await self.screenshot(official_page, 'official-connected')

    async def confirm_official_target(self, page, official):
        require(isinstance(official.get('targetDaemon'), str) and isinstance(official.get('targetDaemonText'), str) and official['targetDaemonText'], 'ACCEPTANCE_OFFICIAL_TARGET_SELECTOR_REQUIRED')
        locator = page.locator(official['targetDaemon'])
        await locator.wait_for(state='visible')
        require((await locator.inner_text()).strip() == official['targetDaemonText'], 'ACCEPTANCE_OFFICIAL_TARGET_MISMATCH')

    async def official_select(self, page, key, values, official):
        actions = official.get('actions', {}).get(key)
        selectors = official.get('selectors', {})
        if actions:
            await self.steps(page, actions, values)
            assertion = official.get('selectionAssertions', {}).get(key)
            require(isinstance(assertion, str) and assertion, 'ACCEPTANCE_SELECTION_ASSERTION_REQUIRED')
            require(values[key] in await page.locator(assertion).inner_text(), 'ACCEPTANCE_OFFICIAL_SELECTION_MISMATCH')
        else:
            require(key in selectors, 'ACCEPTANCE_OFFICIAL_SELECTORS_REQUIRED')
            await page.locator(selectors[key]).select_option(values[key])
            require(await page.locator(selectors[key]).input_value() == values[key], 'ACCEPTANCE_OFFICIAL_SELECTION_MISMATCH')

    async def assistant_cursor(self, page, selector):
        return await page.locator(selector).evaluate_all('''nodes => nodes.map(node => ({
          id: node.getAttribute('data-message-id') || node.getAttribute('data-turn-id') || node.id || null,
          text: node.textContent || ''
        }))''')

    async def wait_reply(self, page, selector, marker, previous):
        deadline = time.monotonic() + min(max(float(self.config.get('turnTimeoutSeconds', 180)), 5), 600)
        while time.monotonic() < deadline:
            current = await self.assistant_cursor(page, selector)
            if current and re.search(r'not logged in|please (?:log|sign) in|authentication (?:failed|required)|invalid api key|token (?:expired|revoked)', current[-1]['text'], re.I):
                raise AcceptanceError('ACCEPTANCE_PROVIDER_AUTH_REQUIRED')
            if current and re.search(r'quota (?:exceeded|exhausted)|usage limit reached|you.ve hit your (?:weekly|daily|monthly|usage|rate) limit|insufficient_quota', current[-1]['text'], re.I):
                raise AcceptanceError('ACCEPTANCE_PROVIDER_QUOTA_EXHAUSTED')
            if current and marker in current[-1]['text']:
                # Same text in a replacement bounded window needs a distinct message/turn ID.
                fresh = len(current) > len(previous) or (current[-1]['id'] and (not previous or current[-1]['id'] != previous[-1]['id']))
                if fresh:
                    return current
            await asyncio.sleep(0.5)
        raise AcceptanceError('ACCEPTANCE_UI_REPLY_NOT_FRESH')

    async def ui_chat(self):
        selected = signed_in_providers(self.config)
        official = self.config.get('official', {})
        selectors = official.get('selectors', {})
        require(all(key in selectors for key in ('title', 'prompt', 'send', 'assistant', 'ownedTitle', 'archived')), 'ACCEPTANCE_OFFICIAL_SELECTORS_REQUIRED')
        require(official.get('actions', {}).get('newAgent') and (selectors.get('archive') or official.get('actions', {}).get('archive')), 'ACCEPTANCE_OFFICIAL_ACTIONS_REQUIRED')
        start = official.get('startUrl', 'https://app.paseo.sh/')
        parsed = urlsplit(start)
        require(parsed.scheme == 'https' and parsed.hostname == 'app.paseo.sh' and not parsed.username and not parsed.password and not parsed.query and not parsed.fragment, 'ACCEPTANCE_OFFICIAL_APP_ORIGIN_INVALID')
        rows = []
        for provider in selected:
            row = {'provider': provider, 'passed': False, 'cleanup': {'archived': False}}
            owned = False
            title = 'OD Paseo acceptance ' + uuid.uuid4().hex[:16]
            row['ownedTestTitle'] = title
            marker = 'OD_PASEO_' + uuid.uuid4().hex[:12]
            values = {'provider': provider, 'model': self.config.get('models', {}).get(provider, ''), 'mode': self.config.get('modes', {}).get(provider, ''), 'title': title, 'prompt': f'Connection acceptance only. Do not use tools or edit files. Remember {marker}. Reply with exactly {marker}.'}
            try:
                # Catalog reads use a separate protected context. Official App
                # contexts and their storage state never receive OD credentials.
                protected = await self.browser.new_context(http_credentials={'username': self.auth['username'], 'password': self.auth['password'], 'origin': self.origin}, service_workers='block')
                try:
                    response = await protected.request.post(self.origin + '/api/paseo-bridge', data={'action': 'models', 'provider': provider}, max_redirects=0, timeout=180000)
                    require(response.ok, 'ACCEPTANCE_CATALOG_HTTP_FAILED')
                    catalog = await response.json()
                    require(isinstance(catalog, dict), 'ACCEPTANCE_CATALOG_SCHEMA')
                    model, mode = catalog_selection(catalog.get('catalog', catalog), provider, values['model'], values['mode'])
                finally:
                    await protected.close()
                values.update(model=model, mode=mode or '')
                await self.page.goto(start, wait_until='domcontentloaded')
                if official.get('actions', {}).get('selectDaemon'):
                    await self.steps(self.page, official['actions']['selectDaemon'], {})
                await self.confirm_official_target(self.page, official)
                await self.steps(self.page, official['actions']['newAgent'], values)
                for key in ('provider', 'model'):
                    await self.official_select(self.page, key, values, official)
                if mode is None:
                    await self.no_mode_control(self.page, selectors.get('mode'), allow_absent=True)
                else:
                    await self.official_select(self.page, 'mode', values, official)
                row.update(model=model, modeId=mode)
                row['selectionConfirmed'] = True
                await self.page.locator(selectors['title']).fill(title)
                before = await self.assistant_cursor(self.page, selectors['assistant'])
                await self.page.locator(selectors['prompt']).fill(values['prompt'])
                if official.get('actions', {}).get('create'):
                    await self.steps(self.page, official['actions']['create'], values)
                else:
                    await self.page.locator(selectors['send']).click()
                # An exact unique title is required before this agent can ever be archived.
                require((await self.page.locator(selectors['ownedTitle']).inner_text()).strip() == title, 'ACCEPTANCE_UI_AGENT_OWNERSHIP_UNCONFIRMED')
                owned = True
                first = await self.wait_reply(self.page, selectors['assistant'], marker, before)
                row['firstReply'] = True
                await self.page.locator(selectors['prompt']).fill('Which marker did I ask you to remember? Reply with that marker only. Do not use tools or edit files.')
                await self.page.locator(selectors['send']).click()
                second = await self.wait_reply(self.page, selectors['assistant'], marker, first)
                row['followup'] = row['freshCursor'] = True
                row['transcript'] = [{'characters': len(items[-1]['text']), 'sha256': hashlib.sha256(items[-1]['text'].encode()).hexdigest(), 'markerMatched': True} for items in (first, second)]
                await self.screenshot(self.page, 'chat-' + provider)
            except Exception as error:
                row['code'] = safe_code(error)
            finally:
                if owned:
                    try:
                        require((await self.page.locator(selectors['ownedTitle']).inner_text()).strip() == title, 'ACCEPTANCE_UI_AGENT_OWNERSHIP_CHANGED')
                        if official.get('actions', {}).get('archive'):
                            await self.steps(self.page, official['actions']['archive'], values)
                        else:
                            await self.page.locator(selectors['archive']).click()
                        confirmation = selectors.get('archived')
                        require(confirmation, 'ACCEPTANCE_ARCHIVE_RECEIPT_REQUIRED')
                        await self.page.locator(confirmation).wait_for(state='visible')
                        row['cleanup']['archived'] = True
                    except Exception:
                        row['cleanup']['code'] = 'ACCEPTANCE_CLEANUP_FAILED'
                row['passed'] = bool(row.get('selectionConfirmed') and row.get('firstReply') and row.get('followup') and row['cleanup']['archived'])
            rows.append(row)
        self.evidence['providers'] = rows
        self.evidence['unverifiedProviders'] = [provider for provider in PROVIDERS if provider not in selected]
        self.evidence['allProvidersVerified'] = all(any(row['provider'] == provider and row['passed'] for row in rows) for provider in PROVIDERS)
        require(all(row['passed'] for row in rows), 'ACCEPTANCE_UI_CHAT_FAILED')

    async def acceptance(self):
        selected = signed_in_providers(self.config)
        await self.setup()
        rows = []
        for provider in selected:
            model = self.config.get('models', {}).get(provider)
            require(isinstance(model, str) and bool(model.strip()), 'ACCEPTANCE_EXPLICIT_UI_SELECTION_REQUIRED')
            catalog = await self.setup_catalog(provider)
            model, mode = catalog_selection(catalog, provider, model, self.config.get('modes', {}).get(provider))
            await self.page.locator(self.selectors['model']).select_option(model)
            require(await self.page.locator(self.selectors['model']).input_value() == model, 'ACCEPTANCE_MODEL_UI_MISMATCH')
            await self.setup_mode(mode)
            prior_status = unwrap_status(await self.bridge())
            prior_receipt = prior_status.get('lastVerification') or prior_status.get('acceptance') or {}
            requested_at = time.time()
            async with self.page.expect_response(lambda r: urlsplit(r.url).path == '/api/paseo-bridge' and r.request.method == 'POST' and 'acceptance' in (r.request.post_data or ''), timeout=600000) as pending:
                await self.page.locator(self.selectors['acceptance']).click()
            response = await pending.value
            require(response.ok, 'ACCEPTANCE_GUI_TEST_HTTP_FAILED')
            value = await response.json()
            if response.status == 202:
                operation_id = value.get('operation', {}).get('id') or value.get('operationId')
                require(operation_id, 'ACCEPTANCE_OPERATION_RECEIPT_REQUIRED')
                deadline = time.monotonic() + 600
                while time.monotonic() < deadline:
                    status = unwrap_status(await self.bridge())
                    operation = status.get('operation') or {}
                    if operation.get('id') == operation_id and operation.get('action') == 'acceptance':
                        require(operation.get('status') not in ('error', 'interrupted'), 'ACCEPTANCE_OPERATION_FAILED')
                        if operation.get('status') == 'completed':
                            value = status.get('lastVerification') or status.get('acceptance') or {}
                            break
                    await asyncio.sleep(2)
                else:
                    raise AcceptanceError('ACCEPTANCE_OPERATION_TIMEOUT')
            receipt = value.get('acceptance', value)
            checked_at = verification_time(receipt)
            require(checked_at >= requested_at - 5 and checked_at <= time.time() + 5 and receipt.get('checkedAt') != prior_receipt.get('checkedAt'), 'ACCEPTANCE_FRESH_RECEIPT_REQUIRED')
            matched = [row for row in receipt.get('providers', []) if row.get('provider') == provider]
            require(len(matched) == 1, 'ACCEPTANCE_GUI_TEST_SCHEMA')
            row = matched[0]
            passed = row.get('passed') is True and row.get('firstReply') is True and row.get('followup') is True and row.get('cleanup', {}).get('archived') is True and row.get('model') == model and row.get('modeId') == mode
            rows.append({'provider': provider, 'model': model, 'modeId': mode, 'passed': passed, 'firstReply': row.get('firstReply') is True, 'followup': row.get('followup') is True, 'cleanup': {'archived': row.get('cleanup', {}).get('archived') is True}})
        self.evidence['providers'] = rows
        self.evidence['unverifiedProviders'] = [p for p in PROVIDERS if p not in selected]
        self.evidence['allProvidersVerified'] = all(any(row['provider'] == provider and row['passed'] for row in rows) for provider in PROVIDERS)
        require(all(row['passed'] for row in rows), 'ACCEPTANCE_GUI_TEST_FAILED')
        await self.screenshot(self.page, 'gui-acceptance')

    async def mobile(self):
        rows = []
        for width in (320, 375, 390, 768):
            await self.page.set_viewport_size({'width': width, 'height': 844})
            await self.setup()
            dimensions = await self.page.evaluate('''() => ({
              viewport: document.documentElement.clientWidth,
              document: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
              escapes: [...document.querySelectorAll('main,section,button,select,a,input')].filter(e => {
                const r = e.getBoundingClientRect();
                return r.width && r.height && getComputedStyle(e).position !== 'absolute' && (r.left < -1 || r.right > document.documentElement.clientWidth + 1);
              }).length
            })''')
            row = {'width': width, 'documentOverflow': max(0, dimensions['document'] - dimensions['viewport']), 'escapingControls': dimensions['escapes']}
            row['passed'] = row['documentOverflow'] <= 1 and row['escapingControls'] == 0
            rows.append(row)
            await self.screenshot(self.page, 'mobile-' + str(width))
        self.evidence['viewports'] = rows
        require(all(row['passed'] for row in rows), 'ACCEPTANCE_MOBILE_OVERFLOW')

    async def recovery(self):
        config = self.config.get('recovery', {})
        require(isinstance(config.get('expectedEnabled'), bool) and isinstance(config.get('expectedReady'), bool) and isinstance(config.get('expectedOnboardingId'), str) and config['expectedOnboardingId'], 'ACCEPTANCE_RECOVERY_EXPECTATIONS_REQUIRED')
        rows = []
        for index in range(min(max(int(config.get('samples', 3)), 2), 30)):
            if index:
                await asyncio.sleep(min(max(float(config.get('intervalMs', 2000)) / 1000, 0), 10))
            value = await self.bridge()
            row = status_evidence(value)
            row['sameOnboarding'] = onboarding_id(value) == config['expectedOnboardingId']
            row['passed'] = row['sameOnboarding'] and row['desiredEnabled'] == config['expectedEnabled'] and row['ready'] == config['expectedReady']
            if not config['expectedReady']:
                row['passed'] = row['passed'] and not row['running'] and not row['reachable']
            rows.append(row)
        self.evidence['samples'] = rows
        require(all(row['passed'] for row in rows), 'ACCEPTANCE_RECOVERY_FAILED')
        await self.setup()
        await self.screenshot(self.page, 'recovery')

    async def run(self):
        from playwright.async_api import async_playwright
        # All dependent preconditions checked before opening a browser that can write.
        if self.args.phase in MUTATING:
            authorized_target(self.target, self.config)
        if self.args.phase in ('ui-chat', 'acceptance'):
            signed_in_providers(self.config)
        async with async_playwright() as playwright:
            self.browser = await playwright.chromium.launch(headless=True)
            try:
                options = {'viewport': {'width': 1440, 'height': 1000}, 'service_workers': 'block'}
                if self.args.phase == 'ui-chat':
                    state = read_private_json(PRIVATE_ROOT / 'official-browser-state.json')
                    options['storage_state'] = state
                else:
                    options['http_credentials'] = {'username':self.auth['username'],'password':self.auth['password'],'origin':self.origin}
                self.context = await self.browser.new_context(**options)
                await self.context.route('**/*', self.guard)
                await self.context.route_web_socket('**/*', self.guard_socket)
                self.page = await self.context.new_page()
                self.page.set_default_timeout(30000)
                self.page.on('pageerror', lambda _: self.events.__setitem__('pageErrors', self.events['pageErrors'] + 1))
                if self.args.phase == 'native':
                    await self.native_check()
                elif self.args.phase == 'enable':
                    await self.toggle(True)
                elif self.args.phase == 'disable':
                    await self.toggle(False)
                elif self.args.phase == 'ui-chat':
                    await self.ui_chat()
                else:
                    await getattr(self, self.args.phase)()
                require(self.events['pageErrors'] == 0, 'ACCEPTANCE_BROWSER_SCRIPT_ERROR')
                self.evidence['passed'] = True
            except Exception as error:
                self.evidence['code'] = safe_code(error)
            finally:
                self.evidence['events'] = self.events
                await self.browser.close()
        return self.evidence


async def main(argv=None):
    args = None
    evidence = {'schemaVersion': 1, 'harness': 'playwright', 'passed': False}
    try:
        args = parse_args(argv)
        config = read_private_json(args.config, optional=args.phase not in MUTATING)
        target = read_private_json(PRIVATE_ROOT / 'target.json')
        if args.phase in MUTATING:
            authorized_target(target, config)
        auth = read_private_json(PRIVATE_ROOT / 'browser-auth.json')
        harness = Harness(args, config, target, auth)
        evidence = await harness.run()
    except Exception as error:
        evidence['code'] = safe_code(error)
    try:
        write_private_json(args.evidence if args and args.evidence else PRIVATE_ROOT / 'evidence' / ('browser-' + (args.phase if args else 'invalid') + '-' + uuid.uuid4().hex + '.json'), evidence)
    except Exception:
        evidence = {'schemaVersion': 1, 'passed': False, 'code': 'ACCEPTANCE_EVIDENCE_WRITE_FAILED'}
    print(json.dumps(evidence, separators=(',', ':')))
    return 0 if evidence['passed'] else 1


if __name__ == '__main__':
    # Playwright debug output is not evidence and can contain auth/page URLs.
    import logging
    logging.disable(logging.CRITICAL)
    os.environ.pop('DEBUG', None)
    os.environ.pop('PWDEBUG', None)
    sys.exit(asyncio.run(main()))
