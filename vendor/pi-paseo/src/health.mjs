const providers=['claude','codex','pi'];
const safeCode=value=>/^[A-Z][A-Z0-9_]{0,63}$/.test(value||'')?value:null;
/** A current operational check, separately reporting historical chat acceptance. */
export function healthReport(status,{checkedAt=new Date().toISOString()}={}) {
 const s=status||{},codes=[];
 if(!s.installed)codes.push('NOT_INSTALLED');
 if(!s.enabled)codes.push('SERVICE_DISABLED');
 if(s.daemon?.owned!==true)codes.push('DAEMON_NOT_OWNED');
 if(s.daemon?.running!==true)codes.push('DAEMON_STOPPED');
 if(s.daemon?.reachable!==true)codes.push('DAEMON_UNREACHABLE');
 const diagnostic=safeCode(s.diagnosticCode);if(diagnostic)codes.push(diagnostic);
 const rows=providers.map(provider=>{
  const entry=s.providers?.find(x=>x.provider===provider);
  const launcher=s.state?.providerLaunchers?.[provider];
  const available=entry?.enabled!==false&&['ready','available'].includes(entry?.status)&&launcher?.startup==='ready';
  if(!available)codes.push(`PROVIDER_${provider.toUpperCase()}_UNAVAILABLE`);
  return {provider,available,lastChatPassed:entry?.chatVerified===true};
 });
 const acceptance=s.state?.acceptance;
 const chatCheckedAt=typeof acceptance?.checkedAt==='string'&&Number.isFinite(Date.parse(acceptance.checkedAt))?acceptance.checkedAt:null;
 return {schemaVersion:1,checkedAt,ready:codes.length===0,codes:[...new Set(codes)],daemon:{running:s.daemon?.running===true,reachable:s.daemon?.reachable===true,relayEnabled:s.daemon?.relayEnabled===true},providers:rows,chatAcceptance:{passed:acceptance?.passed===true,checkedAt:chatCheckedAt,historical:true}};
}
