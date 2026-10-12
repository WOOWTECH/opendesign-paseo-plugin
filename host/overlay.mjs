import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {atomicJson,assertSafePath,privateDirectory,RuntimeError} from '../vendor/pi-paseo/src/state.mjs';
import {applyVerifiedOverlay,replaceVerifiedFile} from '../bin/preload.mjs';

export const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
export function replaceOnce(source,anchor,replacement){
 if(source.split(anchor).length!==2)throw new RuntimeError('HOST_NOT_COMPATIBLE');
 return source.replace(anchor,replacement);
}
export function patchServer(source,packageRoot){
 const url=JSON.stringify(pathToFileURL(path.join(packageRoot,'host/adapter.mjs')).href);
 source=`import { installBridgeBodyParser, registerPaseoBridge } from ${url};\nimport { recoverManagedPaseoPlugin } from './plugins/installer.js';\n`+source;
 source=replaceOnce(source,"    app.use(express.json({ limit: '4mb' }));","    installBridgeBodyParser(app, { allowedOrigins: configuredAllowedOrigins() });\n    app.use(express.json({ limit: '4mb' }));");
 source=replaceOnce(source,'    if (fs.existsSync(staticDir)) {',`    let woowPaseoBridge = { start() {}, disarm() {}, async shutdown() {} };
    let woowPaseoStartupPhase = 'recovery';
    try {
        await recoverManagedPaseoPlugin(db, PLUGIN_REGISTRY_ROOTS, PLUGIN_LOCKFILE_PATH);
        woowPaseoStartupPhase = 'registration';
        woowPaseoBridge = registerPaseoBridge(app, { dataDir: RUNTIME_DATA_DIR, home: process.env.HOME, port: resolvedPort || port, allowedOrigins: configuredAllowedOrigins(), getInstalledPluginRecord: () => getInstalledPlugin(db, 'woowtech-paseo'), mcpConfig: await import('./mcp-config.js') });
    } catch (error) {
        const recoveryCodes = new Set(['PLUGIN_TRANSACTION_ABORTED', 'PLUGIN_TRANSACTION_BUSY', 'PLUGIN_TRANSACTION_CONFLICT', 'PLUGIN_TRANSACTION_INVALID_JOURNAL', 'PLUGIN_TRANSACTION_INVALID_OPTIONS', 'PLUGIN_TRANSACTION_INVALID_RECORD', 'PLUGIN_TRANSACTION_LOCK_FAILED', 'PLUGIN_TRANSACTION_RECORD_SCOPE', 'PLUGIN_TRANSACTION_RECOVERY_CONFLICT', 'PLUGIN_TRANSACTION_UNSAFE_PATH']);
        const code = woowPaseoStartupPhase === 'recovery' ? (recoveryCodes.has(error?.code) ? error.code : 'PLUGIN_TRANSACTION_RECOVERY_FAILED') : 'PASEO_BRIDGE_REGISTRATION_FAILED';
        console.warn('[woow-paseo] ' + woowPaseoStartupPhase + ' blocked (' + code + '); original OpenDesign remains available');
        const blocked = (_req, res) => { res.setHeader('Cache-Control', 'private, no-store'); res.setHeader('Referrer-Policy', 'no-referrer'); return res.status(503).json({ error: { code, phase: woowPaseoStartupPhase } }); };
        for (const route of ['/api/paseo-bridge', '/paseo/setup', '/paseo/entry.js', '/paseo/assets/setup.js', '/paseo/assets/setup.css']) app.get(route, blocked);
        app.post('/api/paseo-bridge', blocked);
    }
    if (fs.existsSync(staticDir)) {`);
 source=replaceOnce(source,'                daemonUrl = url;','                daemonUrl = url;\n                woowPaseoBridge.start();');
 source=replaceOnce(source,'        const cleanupDaemonBackgroundWork = () => {','        const cleanupDaemonBackgroundWork = () => {\n            woowPaseoBridge.disarm();');
 source=replaceOnce(source,'            daemonShutdownStarted = true;','            daemonShutdownStarted = true;\n            await woowPaseoBridge.shutdown();');
 return source;
}
export function patchMcpConfig(source){
 source=replaceOnce(source,'    const next = sanitizeMcpConfig(body);',"    const next = sanitizeMcpConfig(typeof body === 'function' ? await body(await readMcpConfig(dataDir)) : body);");
 source=replaceOnce(source,"    await writeFile(tmp, JSON.stringify(next, null, 2), 'utf8');","    await writeFile(tmp, JSON.stringify(next, null, 2), { encoding: 'utf8', mode: 0o600, flag: 'wx' });");
 return source;
}
export function patchPluginRoutes(source,packageRoot){
 // The guarded central installer now stops the managed service after all native
 // route authority checks, including CLI callers. Keep route policy bytes intact.
 const anchor='const result = await plugins.uninstallPlugin(db, req.params.id, paths.PLUGIN_REGISTRY_ROOTS);';
 return replaceOnce(source,anchor,anchor);
}
export function patchLockfile(source){
 if(source.includes('export function withManagedPluginLockfileQueue'))throw new RuntimeError('HOST_NOT_COMPATIBLE');
 replaceOnce(source,'async function withLockfileQueue(filePath, task) {','async function withLockfileQueue(filePath, task) {');
 return source+'\nexport function withManagedPluginLockfileQueue(filePath, task) { return withLockfileQueue(filePath, task); }\n';
}
export function patchInstaller(source,packageRoot){
 const transactionUrl=JSON.stringify(pathToFileURL(path.join(packageRoot,'host/plugin-transaction.mjs')).href);
 const adapterUrl=JSON.stringify(pathToFileURL(path.join(packageRoot,'host/adapter.mjs')).href);
 const goldenRoot=JSON.stringify(path.join(packageRoot,'plugin'));
 const originalCopy="    yield { kind: 'progress', phase: 'copying', message: `Copying to ${destFolder}` };";
 const eventStart=source.indexOf("    // Plan §3.II1 / §3.JJ1 — emit 'plugin.installed' OR");
 const eventEnd=source.indexOf("    yield { kind: 'success', plugin: parsed.record, warnings };",eventStart);
 if(eventStart<0||eventEnd<eventStart)throw new RuntimeError('HOST_NOT_COMPATIBLE');
 const nativeEvents=source.slice(eventStart,eventEnd);
 source=replaceOnce(source,"import { upsertPluginLockfileEntry } from './lockfile.js';","import { upsertPluginLockfileEntry, lockEntryFromInstalled, withManagedPluginLockfileQueue } from './lockfile.js';");
 source=replaceOnce(source,originalCopy,`    if (pluginId === 'woowtech-paseo') {
        yield { kind: 'progress', phase: 'copying', message: 'Staging managed plugin' };
        let parsed;
        try {
            parsed = await installNativeManagedPlugin(woowPaseoTransactionOptions(db, roots, opts.lockfilePath), {
                maxBytes,
                copy: folder => safeCopyTree(sourceFolder, folder, maxBytes),
                parse: folder => woowPaseoResolveManagedFolder({ folder, folderId: pluginId, sourceKind: recordedSourceKind, source: recordedSource }, opts),
            });
        } catch (error) {
            const code = error?.code === 'PLUGIN_TRANSACTION_STAGE_INVALID' ? 'INVALID_MANIFEST' : /CONFLICT|BUSY/.test(error?.code || '') ? 'CONFLICT' : 'INTERNAL_ERROR';
            yield { kind: 'error', code, message: 'Managed plugin transaction failed', warnings };
            return;
        }
        warnings.push(...parsed.warnings);
${nativeEvents}
        yield { kind: 'success', plugin: parsed.record, warnings };
        return;
    }
${originalCopy}`);
 source=replaceOnce(source,'export async function uninstallPlugin(db, id, roots = defaultRegistryRoots()) {','async function woowPaseoOriginalUninstall(db, id, roots = defaultRegistryRoots()) {');
 source=`import { installNativeManagedPlugin, nativeManagedPluginTransactionOptions, recoverManagedPluginTransaction, withManagedPluginMutationLock } from ${transactionUrl};\nimport { stopBeforeNativeUninstall } from ${adapterUrl};\n`+source;
 return source+`
async function woowPaseoResolveManagedFolder(base, opts) {
    const parsed = await resolvePluginFolder(buildResolveOptions(base, opts));
    if (!parsed.ok) return parsed;
    // Native schema acceptance alone cannot establish host compatibility. The
    // immutable host release and adapter must agree on these exact guide bytes.
    try {
        for (const name of ['open-design.json', 'SKILL.md']) {
            const file = path.join(base.folder, name), golden = path.join(${goldenRoot}, name);
            const stagedStat = fs.lstatSync(file), goldenStat = fs.lstatSync(golden);
            if (!stagedStat.isFile() || stagedStat.nlink !== 1 || !goldenStat.isFile() || goldenStat.nlink !== 1 || !fs.readFileSync(file).equals(fs.readFileSync(golden))) {
                return { ok: false, errors: ['Managed plugin does not match the compatible host release'], warnings: parsed.warnings };
            }
        }
    } catch {
        return { ok: false, errors: ['Managed plugin does not match the compatible host release'], warnings: parsed.warnings };
    }
    return parsed;
}
function woowPaseoTransactionOptions(db, roots, lockfilePath) {
    return nativeManagedPluginTransactionOptions({ dataDir: path.dirname(path.resolve(roots.userPluginsRoot)), roots, db, lockfilePath,
        native: { getInstalledPlugin, upsertInstalledPlugin, deleteInstalledPlugin, lockEntryFromInstalled, withManagedPluginLockfileQueue } });
}
export async function recoverManagedPaseoPlugin(db, roots = defaultRegistryRoots(), lockfilePath) {
    return recoverManagedPluginTransaction(woowPaseoTransactionOptions(db, roots, lockfilePath));
}
export async function uninstallPlugin(db, id, roots = defaultRegistryRoots()) {
    if (id !== 'woowtech-paseo') return woowPaseoOriginalUninstall(db, id, roots);
    return withManagedPluginMutationLock(woowPaseoTransactionOptions(db, roots), async () => {
        await stopBeforeNativeUninstall(id);
        return woowPaseoOriginalUninstall(db, id, roots);
    });
}
`;
}
export function patchHtml(source){source=replaceOnce(source,'</head>','<link rel="stylesheet" href="/paseo/assets/setup.css"></head>');return replaceOnce(source,'</body>','<script src="/paseo/entry.js" defer></script></body>');}
const patchers={'apps/daemon/dist/server.js':patchServer,'apps/daemon/dist/mcp-config.js':patchMcpConfig,'apps/daemon/dist/routes/plugins/index.js':patchPluginRoutes,'apps/daemon/dist/plugins/installer.js':patchInstaller,'apps/daemon/dist/plugins/lockfile.js':patchLockfile,'apps/web/out/index.html':patchHtml};
export function buildOverlay({hostRoot,packageRoot,overlayRoot,compatibility}){
 privateDirectory(overlayRoot);const entries=[];
 for(const [relative,expected] of Object.entries(compatibility.files)){
  if(!Object.hasOwn(patchers,relative))throw new RuntimeError('HOST_NOT_COMPATIBLE');
  const destination=path.join(hostRoot,relative);assertSafePath(destination);
  const stat=fs.lstatSync(destination);if(!stat.isFile()||stat.nlink!==1)throw new RuntimeError('UNSAFE_HOST_TARGET');
  const before=fs.readFileSync(destination);if(digest(before)!==expected)throw new RuntimeError('HOST_NOT_COMPATIBLE');
  const after=Buffer.from(patchers[relative](before.toString('utf8'),packageRoot));
  const originalFile=path.join(overlayRoot,relative+'.original'),patchedFile=path.join(overlayRoot,relative+'.patched');
  privateDirectory(path.dirname(originalFile));fs.writeFileSync(originalFile,before,{mode:0o600,flag:'wx'});fs.writeFileSync(patchedFile,after,{mode:0o600,flag:'wx'});
  entries.push({relative,before:expected,after:digest(after),originalFile,patchedFile,mode:stat.mode&0o777});
 }
 const receipt={protocolVersion:1,hostRoot,packageRoot,entries};atomicJson(path.join(overlayRoot,'receipt.json'),receipt);return receipt;
}
export function replaceOwnedFile(file,bytes,allowed,{mode=0o600}={}){
 try{return replaceVerifiedFile(file,bytes,allowed,{mode});}
 catch(error){throw new RuntimeError(error.code==='RELEASE_UNSAFE_PATH'?'UNSAFE_SYMLINK':error.code==='RELEASE_INVALID_FILE'?'HOST_EXTERNAL_CHANGE':error.code||'HOST_EXTERNAL_CHANGE');}
}
export function applyOverlay(receipt,options={}){
 try{return applyVerifiedOverlay(receipt,options);}
 catch(error){throw new RuntimeError(error.code==='RELEASE_UNSAFE_PATH'?'UNSAFE_SYMLINK':error.code==='RELEASE_INVALID_FILE'?'HOST_EXTERNAL_CHANGE':error.code||'HOST_RECEIPT_INVALID');}
}
