const PREFIX='fhl-personal-offline-',CONTROL='fhl-personal-control-v1';let preparing=null;
const url=path=>new URL(path,self.registration.scope).href;
const hash=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');
self.addEventListener('install',event=>event.waitUntil(self.skipWaiting()));
self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));
async function readState(){const r=await (await caches.open(CONTROL)).match(url('./__state__'));return r?await r.json():{};}
async function writeState(s){await (await caches.open(CONTROL)).put(url('./__state__'),new Response(JSON.stringify(s)));}
function validate(m){
  if(!m.version||!m.appVersion||!m.buildId||!Array.isArray(m.assets)||!m.assets.length)throw new Error('离线清单无效');
  const paths=new Set();for(const a of m.assets){const target=new URL(a.path,self.registration.scope);if(!['core','ocr'].includes(a.group)||!Number.isSafeInteger(a.size)||a.size<0||a.size>64*1024*1024||!/^([a-f0-9]{64})$/.test(a.sha256)||target.origin!==self.location.origin||!target.href.startsWith(self.registration.scope)||paths.has(target.href))throw new Error('离线资源地址或校验无效');paths.add(target.href);}return m;
}
async function manifestOf(release){if(!release)return null;const r=await (await caches.open(PREFIX+release.version)).match(url('./offline-assets.json'));return r?validate(await r.json()):null;}
async function validResponse(r,a){if(!r?.ok)return false;const b=await r.clone().arrayBuffer();return b.byteLength===a.size&&await hash(b)===a.sha256;}
async function completed(release,group='core'){
  if(!release)return false;const cache=await caches.open(PREFIX+release.version);
  if(!await cache.match(url('./__ready_'+group)))return false;
  const m=await manifestOf(release);if(!m)return false;
  for(const a of m.assets.filter(a=>a.group===group))if(!await validResponse(await cache.match(url(a.path)),a))return false;return true;
}
async function inventory(signal){const r=await fetch(url('./offline-assets.json'),{cache:'no-store',signal});if(!r.ok)throw new Error('缓存清单无法读取');return validate(await r.json());}
async function prepare(group,signal,emit){
  const state=await readState(),m=group==='ocr'?await manifestOf(state.active):await inventory(signal);if(!m)throw new Error('请先准备基础离线程序');
  if(group==='ocr'&&!await completed(state.active))throw new Error('基础程序尚未就绪');
  const cache=await caches.open(PREFIX+m.version),assets=m.assets.filter(a=>a.group===group),names=(await caches.keys()).filter(n=>n.startsWith(PREFIX));
  let done=0,bytes=0,downloadedBytes=0,reused=0;const totalBytes=assets.reduce((s,a)=>s+a.size,0);
  const progress=(stage,extra=0)=>emit({stage,done,total:assets.length,bytes:bytes+extra,totalBytes,downloadedBytes,reused,group});
  for(const a of assets){
    signal.throwIfAborted();const target=url(a.path);progress('校验资源');let response=await cache.match(target),reuse=false;
    if(!await validResponse(response,a)){
      response=null;
      for(const name of names){signal.throwIfAborted();const previous=await (await caches.open(name)).match(target);if(await validResponse(previous,a)){response=previous;reuse=true;break;}}
      if(!response){
        progress('下载资源');const r=await fetch(target,{cache:'no-store',signal});if(!r.ok)throw new Error('资源未就绪：'+a.path);
        const chunks=[];let received=0;const reader=r.body?.getReader();
        if(reader){try{while(true){signal.throwIfAborted();const next=await reader.read();if(next.done)break;received+=next.value.length;downloadedBytes+=next.value.length;if(received>a.size)throw new Error('资源大小不一致');chunks.push(next.value);progress('下载资源',received);}}finally{reader.releaseLock();}}
        else{const b=new Uint8Array(await r.arrayBuffer());chunks.push(b);received=b.length;downloadedBytes+=b.length;}
        const b=new Uint8Array(received);let at=0;for(const c of chunks){b.set(c,at);at+=c.length;}
        if(received!==a.size||await hash(b.buffer)!==a.sha256)throw new Error('资源校验失败：'+a.path);
        response=new Response(b,{headers:r.headers});
      }
      signal.throwIfAborted();progress(reuse?'复用资源':'写入缓存');await cache.put(target,response.clone());
    }else reuse=true;
    if(reuse)reused++;done++;bytes+=a.size;progress('资源已验证');
  }
  signal.throwIfAborted();await cache.put(url('./offline-assets.json'),new Response(JSON.stringify(m)));await cache.put(url('./__ready_'+group),new Response('ready'));
  if(group==='core'){state.staged={version:m.version,appVersion:m.appVersion,buildId:m.buildId};await writeState(state);}progress('准备完成');return state;
}
async function activate(version){const s=await readState(),release=s.staged?.version===version?s.staged:s.active?.version===version?s.active:null;if(!await completed(release))throw new Error('新版基础资源尚未完整缓存');await writeState({active:release,previous:s.active?.version!==version?s.active:s.previous});return {active:release};}
async function status(s){return {ok:true,ready:await completed(s.active),ocrReady:await completed(s.active,'ocr'),version:s.active?.version,appVersion:s.active?.appVersion,buildId:s.active?.buildId,stagedVersion:s.staged?.version,stagedAppVersion:s.staged?.appVersion,stagedBuildId:s.staged?.buildId};}
self.addEventListener('message',event=>{
  const port=event.ports[0],type=event.data?.type;
  event.waitUntil((async()=>{try{
    if(type==='CANCEL'){preparing?.abort();return port?.postMessage({ok:true});}
    if(type==='STATUS')return port?.postMessage(await status(await readState()));
    if(type==='PREPARE'){
      if(preparing)throw new Error('已有资源任务正在进行');const controller=new AbortController();preparing=controller;
      try{const s=await prepare(event.data.group==='ocr'?'ocr':'core',controller.signal,p=>port?.postMessage({type:'PROGRESS',progress:p}));return port?.postMessage(await status(s));}finally{if(preparing===controller)preparing=null;}
    }
    if(type==='ACTIVATE')return port?.postMessage(await status(await activate(event.data.version)));
    port?.postMessage({ok:false,error:'不支持的离线操作'});
  }catch(e){port?.postMessage({ok:false,error:e.name==='AbortError'?'已取消准备，可继续使用旧版':String(e.message||e)});}})());
});
self.addEventListener('fetch',event=>{
  const r=event.request;if(r.method!=='GET'||new URL(r.url).origin!==self.location.origin||new URL(r.url).pathname.endsWith('/offline-assets.json'))return;
  event.respondWith((async()=>{const s=await readState();if(r.mode==='navigate'){
    if(s.active){const cached=await (await caches.open(PREFIX+s.active.version)).match(url('./index.html'));if(cached)return cached;}
    try{return await fetch(r);}catch{return new Response('请联网完成离线准备',{status:503});}
  }const names=(await caches.keys()).filter(n=>n.startsWith(PREFIX));if(s.active){const current=PREFIX+s.active.version;names.sort((a,b)=>Number(b===current)-Number(a===current));}for(const name of names){const cached=await (await caches.open(name)).match(r,{ignoreVary:true});if(cached)return cached;}return fetch(r);})());
});
