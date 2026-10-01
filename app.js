/* =====================================================================
   Explorateur de configs — ProCurve / OmniSwitch
   Choix de conception orientés performance :
   - visionneuse virtualisée (seules les lignes visibles sont dans le DOM)
   - métadonnées des fichiers chargées à la demande (pas de stat sur tout l'arbre)
   - cache de contenu : mémoire (LRU) + IndexedDB optionnel, validé par taille/date
   - recherche : test global par fichier, découpage en lignes seulement si nécessaire,
     traitement par tranches de temps pour ne jamais figer l'interface
   ===================================================================== */
const $=s=>document.querySelector(s);
const esc=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const reEsc=s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const cssEsc=s=>(window.CSS&&CSS.escape)?CSS.escape(s):s.replace(/["\\]/g,'\\$&');
const fmt=n=>n<1024?n+' o':n<1048576?(n/1024).toFixed(1)+' Ko':(n/1048576).toFixed(1)+' Mo';
const dt=t=>new Date(t).toLocaleString('fr-FR',{dateStyle:'short',timeStyle:'short'});
const parent=p=>p.includes('/')?p.slice(0,p.lastIndexOf('/')):'';
const base=p=>p.slice(p.lastIndexOf('/')+1);
const debounce=(fn,ms)=>{ let t=0; return (...a)=>{ clearTimeout(t); t=setTimeout(()=>fn(...a),ms); }; };
const tick=()=>new Promise(r=>setTimeout(r,0));
const COLL=new Intl.Collator('fr',{sensitivity:'base',numeric:true});
const MAX_FILE=8*1024*1024, MAX_HITS=2000, MAX_RICH=200000, HAS_FSA=!!window.showDirectoryPicker;
const ROW_H=19, BUF=30, MEM_BUDGET=120e6;           // hauteur de ligne (px), tampon de lignes rendues, budget cache mémoire (caractères)
const VN={pc:'ProCurve / ArubaOS-Switch',os:'OmniSwitch',gen:'Générique'};

let files=[], fileByPath=new Map(), tree=new Map(), rootName='', cur={dir:'',file:null}, renderedDir=null;
let stopFlag=false, busy=false, showingResults=false, doc=null, lastSearch=null, listToken=0, openSeq=0;
const VW={on:false,d:null,rs:0,re:0,raf:0,charW:0};

/* ---------- index ---------- */
function build(list,name){
  files=list; rootName=name; fileByPath=new Map(); tree=new Map([['',{d:new Set(),f:[]}]]);
  for(const f of files){
    f.name=base(f.path); f.lc=f.name.toLowerCase(); fileByPath.set(f.path,f);
    const p=f.path.split('/'); let acc='';
    for(let i=0;i<p.length-1;i++){
      const par=acc; acc+=(acc?'/':'')+p[i];
      if(!tree.has(acc)) tree.set(acc,{d:new Set(),f:[]});
      tree.get(par).d.add(acc);
    }
    tree.get(acc).f.push(f);
  }
  tree.forEach(n=>{ n.dirs=[...n.d].sort((a,b)=>COLL.compare(base(a),base(b))); n.f.sort((a,b)=>COLL.compare(a.name,b.name)); });
  cur={dir:'',file:null}; doc=null; lastSearch=null; renderedDir=null;
  rawCache.clear(); dash.raws=[]; dash.meta=null; dash.filter=null; dash.on=false;
  setInfo(); $('#q').disabled=false; $('#go').disabled=false; $('#db').disabled=false;
  clearFilter(); renderList(); empty();
  pruneCache();
}
function setInfo(t){ $('#info').textContent=t!=null?t:(rootName?rootName+' — '+files.length+' fichiers':''); }
function empty(){ dash.on=false; VW.on=false; VW.d=null; showingResults=false; $('#vh').hidden=true; $('#body').innerHTML='<div class="empty">Sélectionne un fichier ou lance une recherche.</div>'; }
function setBusy(on){ busy=on; $('#go').hidden=on; $('#stop').hidden=!on; $('#db').disabled=on; }

/* ---------- sources : File System Access API (Chrome/Edge) ou <input webkitdirectory> (Firefox) ---------- */
/* L'énumération ne fait AUCUN stat : taille/date sont chargées à la demande (voir fillMeta). */
async function walk(dirHandle,prefix,out){
  const jobs=[];
  for await(const [name,h] of dirHandle.entries()){
    const path=prefix?prefix+'/'+name:name;
    if(h.kind==='directory') jobs.push(walk(h,path,out));
    else out.push({path,size:null,mtime:null,get:()=>h.getFile()});
  }
  await Promise.all(jobs);
}
async function loadHandle(h){
  setInfo('Lecture de l\'arborescence…');
  const out=[]; await walk(h,'',out);
  build(out,h.name);
}
function loadFallback(fl){
  if(!fl.length) return;
  const name=fl[0].webkitRelativePath.split('/')[0];
  build([...fl].map(f=>({path:f.webkitRelativePath.split('/').slice(1).join('/'),size:f.size,mtime:f.lastModified,get:async()=>f})),name);
}
$('#pick').onclick=async()=>{
  if(HAS_FSA){
    try{ const h=await showDirectoryPicker({mode:'read'}); saveHandle(h); await loadHandle(h); }
    catch(e){ if(e.name!=='AbortError') $('#body').innerHTML='<div class="err">'+esc(e.message)+'</div>'; }
  } else $('#fallback').click();
};
$('#fallback').onchange=e=>loadFallback(e.target.files);

/* ---------- IndexedDB : dernier dossier + cache de contenu (optionnel) ---------- */
let persist=false; try{ persist=localStorage.getItem('persist')==='1'; }catch{}
let dbP=null;
function db(){
  return dbP||(dbP=new Promise((res,rej)=>{
    try{
      const r=indexedDB.open('cfgbrowser',2);
      r.onupgradeneeded=()=>{ const d=r.result; if(!d.objectStoreNames.contains('h')) d.createObjectStore('h'); if(!d.objectStoreNames.contains('txt')) d.createObjectStore('txt'); };
      r.onsuccess=()=>res(r.result); r.onerror=()=>rej(r.error); r.onblocked=()=>rej(new Error('IndexedDB bloquée'));
    }catch(e){ rej(e); }
  }).catch(e=>{ dbP=null; persist=false; throw e; }));
}
const idbReq=(store,mode,fn)=>db().then(d=>new Promise((res,rej)=>{
  const tx=d.transaction(store,mode), rq=fn(tx.objectStore(store));
  tx.oncomplete=()=>res(rq&&rq.result); tx.onerror=tx.onabort=()=>rej(tx.error);
}));
async function saveHandle(h){ try{ await idbReq('h','readwrite',s=>{ s.put(h,'last'); }); }catch{} }
async function restoreHandle(){
  if(!HAS_FSA) return;
  try{
    const h=await idbReq('h','readonly',s=>s.get('last'));
    if(!h) return;
    const b=$('#reopen'); b.hidden=false; b.textContent='Rouvrir « '+h.name+' »';
    b.onclick=async()=>{ if(await h.requestPermission({mode:'read'})==='granted'){ b.hidden=true; loadHandle(h); } };
  }catch{}
}

/* ---------- cache de contenu ---------- */
const mem=new Map(); let memChars=0;                 // LRU en mémoire (ordre d'insertion = ordre d'usage)
const bad=new Map();                                 // fichiers binaires : évite de les relire
const putQ=[]; let putT=0;
const UTF8=new TextDecoder('utf-8',{fatal:true}), W1252=new TextDecoder('windows-1252');
function memGet(key,size,mtime){
  const e=mem.get(key);
  if(e&&e.size===size&&e.mtime===mtime){ mem.delete(key); mem.set(key,e); return e.text; }
  return null;
}
function memPut(key,size,mtime,text){
  const old=mem.get(key); if(old){ memChars-=old.text.length; mem.delete(key); }
  mem.set(key,{size,mtime,text}); memChars+=text.length;
  for(const [k,v] of mem){ if(memChars<=MEM_BUDGET||mem.size<=1) break; mem.delete(k); memChars-=v.text.length; }
}
async function idbGetText(key,size,mtime){
  if(!persist) return null;
  try{ const v=await idbReq('txt','readonly',s=>s.get(key)); return v&&v.size===size&&v.mtime===mtime?v.text:null; }
  catch{ return null; }
}
function idbQueue(key,size,mtime,text){
  if(!persist) return;
  putQ.push([key,{size,mtime,text}]);
  if(!putT) putT=setTimeout(flushPuts,400);
}
async function flushPuts(){
  putT=0; if(!putQ.length||!persist) return;
  const batch=putQ.splice(0,100);
  try{ await idbReq('txt','readwrite',s=>{ batch.forEach(([k,v])=>s.put(v,k)); }); }
  catch(e){ if(e&&e.name==='QuotaExceededError') persist=false; }
  if(putQ.length) putT=setTimeout(flushPuts,50);
}
async function pruneCache(){                          // retire du cache disque les fichiers disparus du dossier
  if(!persist) return;
  try{
    const keys=await idbReq('txt','readonly',s=>s.getAllKeys(IDBKeyRange.bound(rootName+'|',rootName+'|\uffff')));
    const stale=keys.filter(k=>!fileByPath.has(k.slice(rootName.length+1)));
    if(stale.length) await idbReq('txt','readwrite',s=>{ stale.forEach(k=>s.delete(k)); });
  }catch{}
}
async function clearCache(disk=true){
  mem.clear(); memChars=0; bad.clear(); putQ.length=0;
  if(disk){ try{ await idbReq('txt','readwrite',s=>{ s.clear(); }); }catch{} }
}
/* Retourne le texte d'un fichier : mémoire -> disque (si activé) -> lecture réseau. Renseigne f.size / f.mtime. */
async function getText(f){
  const file=await f.get();
  f.size=file.size; f.mtime=file.lastModified;
  if(file.size>MAX_FILE) throw new Error('fichier trop volumineux ('+Math.round(file.size/1048576)+' Mo)');
  const key=rootName+'|'+f.path, b=bad.get(key);
  if(b&&b.size===file.size&&b.mtime===file.lastModified) throw new Error('fichier binaire');
  let t=memGet(key,file.size,file.lastModified);
  if(t!==null) return t;
  t=await idbGetText(key,file.size,file.lastModified);
  if(t===null){
    const buf=new Uint8Array(await file.arrayBuffer());
    if(buf.subarray(0,4096).includes(0)){ bad.set(key,{size:file.size,mtime:file.lastModified}); throw new Error('fichier binaire'); }
    try{ t=UTF8.decode(buf); }catch{ t=W1252.decode(buf); }
    idbQueue(key,file.size,file.lastModified,t);
  }
  memPut(key,file.size,file.lastModified,t);
  return t;
}

/* ---------- liste des fichiers ---------- */
const metaTxt=f=>f.size==null?'…':(f.mtime?fmt(f.size)+' · '+dt(f.mtime):'—');
function clearFilter(){ const i=$('#filter'); i.value=''; if(i.nextElementSibling) i.nextElementSibling.hidden=true; }
function renderList(){
  const node=tree.get(cur.dir); if(!node) return;
  const q=$('#filter').value.toLowerCase(), tok=++listToken;
  const parts=cur.dir?cur.dir.split('/'):[]; let acc='';
  let c='<a data-d="">'+esc(rootName)+'</a>';
  parts.forEach(p=>{ acc+=(acc?'/':'')+p; c+=' / <a data-d="'+esc(acc)+'">'+esc(p)+'</a>'; });
  $('#crumbs').innerHTML=c;
  let h=cur.dir?'<div class="row" data-up="1"><span>⬆️</span><span class="n">..</span></div>':'';
  for(const d of node.dirs){ const n=base(d); if(!q||n.toLowerCase().includes(q)) h+='<div class="row" data-dir="'+esc(d)+'"><span>📁</span><span class="n">'+esc(n)+'</span></div>'; }
  const pending=[];
  for(const f of node.f){
    if(q&&!f.lc.includes(q)) continue;
    if(f.size==null) pending.push(f);
    h+='<div class="row'+(f.path===cur.file?' sel':'')+'" data-f="'+esc(f.path)+'" title="'+esc(f.name)+'"><span>📄</span><span class="n">'+esc(f.name)+'<span class="m" data-mp="'+esc(f.path)+'">'+metaTxt(f)+'</span></span></div>';
  }
  $('#list').innerHTML=h||'<div class="note">Vide</div>';
  renderedDir=cur.dir;
  if(pending.length) fillMeta(pending,tok);
}
/* taille/date : chargées à la demande, 12 en parallèle, uniquement pour le dossier affiché */
async function fillMeta(list,tok){
  const els=new Map(); $('#list').querySelectorAll('[data-mp]').forEach(e=>els.set(e.dataset.mp,e));
  let i=0;
  const worker=async()=>{
    while(i<list.length){
      const f=list[i++]; if(f.size!=null) continue;
      try{ const fl=await f.get(); f.size=fl.size; f.mtime=fl.lastModified; }catch{ f.size=0; f.mtime=0; }
      if(tok===listToken){ const el=els.get(f.path); if(el) el.textContent=metaTxt(f); }
    }
  };
  await Promise.all(Array.from({length:12},worker));
}
function markSel(){
  const l=$('#list'), o=l.querySelector('.row.sel'); if(o) o.classList.remove('sel');
  if(cur.file){ const n=l.querySelector('.row[data-f="'+cssEsc(cur.file)+'"]'); if(n) n.classList.add('sel'); }
}
$('#list').addEventListener('click',e=>{
  const r=e.target.closest('.row'); if(!r) return;
  if(r.dataset.up){ cur.dir=parent(cur.dir); clearFilter(); renderList(); }
  else if(r.dataset.dir!==undefined){ cur.dir=r.dataset.dir; clearFilter(); renderList(); }
  else openFile(r.dataset.f,0);
});
$('#crumbs').addEventListener('click',e=>{ const a=e.target.closest('a[data-d]'); if(a){ cur.dir=a.dataset.d; clearFilter(); renderList(); } });
$('#filter').oninput=debounce(renderList,80);
/* préchargement : survol prolongé d'un fichier -> il est déjà en cache au clic */
let hoverT=0;
$('#list').addEventListener('mouseover',e=>{
  clearTimeout(hoverT);
  const r=e.target.closest('.row[data-f]'); if(!r||busy) return;
  hoverT=setTimeout(()=>{ const f=fileByPath.get(r.dataset.f); if(f&&(f.size==null||f.size<2e6)&&(!doc||doc.path!==f.path)) getText(f).catch(()=>{}); },200);
});

/* =====================================================================
   Analyse : constructeur, coloration, sections repliables
   ===================================================================== */
function detectVendor(lines){
  let os=0, pc=0;
  const n=Math.min(lines.length,4000);
  for(let i=0;i<n;i++){
    const l=lines[i];
    if(/^!\s*\S.*:\s*$/.test(l)) os+=2;
    if(/^system name\b/i.test(l)||/^vlan \d+ (admin-state|enable|disable|members|port|802\.1q|name)\b/i.test(l)) os+=1;
    if(/^;\s.*(Configuration Editor|Created on release)/i.test(l)) pc+=5;
    if(/^hostname\s+"/i.test(l)) pc+=2;
    if(/^vlan \d+\s*$/i.test(l)) pc+=1;
    if(/^\s+exit\s*$/i.test(l)) pc+=1;
  }
  return os>pc?'os':(pc>0?'pc':'gen');
}

/* --- tokenisation (coloration) --- */
const TOK=/("(?:[^"\\]|\\.)*"?)|(\b\d{1,3}(?:\.\d{1,3}){3}\b)|([A-Za-z_][\w.\/-]*)|(\d+(?:[-\/,:.]\d+)*)/g;
const KW=new Set(['name','tagged','untagged','exit','enable','disable','admin-state','members','port','address','mask','gateway','community','host','speed-duplex','lacp','trunk','mode','alias','description','default','dhcp-bootp','unrestricted','restricted','operator','manager','version','severity','static-route','interface','interfaces','vlan','ip','snmp','snmp-server']);
const NEG=/^(no|shutdown|disable|disabled|forbid)$/i;
const ID_HEAD=/^(vlan|interface|interfaces)$/i;
function tokenize(l){
  if(l.length>2000) return [['',l]];
  const t=l.trimStart(), c=t[0];
  if(c===';'||c==='!'||c==='#') return [['c-cm',l]];
  const top=l.length===t.length, fw=(/^\s*(\S+)/.exec(l)||[])[1]||'';
  const segs=[]; let last=0, idx=0, m;
  TOK.lastIndex=0;
  while((m=TOK.exec(l))){
    if(m.index>last) segs.push(['',l.slice(last,m.index)]);
    let cls='';
    if(m[1]) cls='c-str';
    else if(m[2]) cls='c-ip';
    else if(m[3]){
      const w=m[3];
      if(idx===0) cls=NEG.test(w)?'c-neg':(top?'c-blk':'c-kw');
      else if(NEG.test(w)) cls='c-neg';
      else if(KW.has(w.toLowerCase())) cls='c-kw';
      else if(/^(trk|trunk)\d+$/i.test(w)||/^[A-Z]\d+(-[A-Z]?\d+)?$/.test(w)) cls='c-port';
    } else cls=(idx===1&&top&&ID_HEAD.test(fw))?'c-id':'c-num';
    segs.push([cls,m[0]]); last=m.index+m[0].length; idx++;
  }
  if(last<l.length) segs.push(['',l.slice(last)]);
  return segs;
}
/* segments [classe,texte] + plages surlignées -> HTML */
function emit(segs,ranges){
  let pos=0, ri=0, out='';
  for(const [cls,text] of segs){
    const s=pos, e=pos+text.length; let c=s, piece='';
    while(c<e){
      while(ri<ranges.length&&ranges[ri][1]<=c) ri++;
      const r=ranges[ri];
      if(r&&r[0]<e){
        if(r[0]>c){ piece+=esc(text.slice(c-s,r[0]-s)); c=r[0]; }
        const end=Math.min(r[1],e);
        piece+='<mark>'+esc(text.slice(c-s,end-s))+'</mark>'; c=end;
      } else { piece+=esc(text.slice(c-s)); c=e; }
    }
    out+=cls?'<span class="'+cls+'">'+piece+'</span>':piece;
    pos=e;
  }
  return out;
}
function rangesOf(text,rg){
  const out=[]; let m; rg.lastIndex=0;
  while((m=rg.exec(text))){ if(!m[0].length){ rg.lastIndex++; continue; } out.push([m.index,m.index+m[0].length]); }
  return out;
}
const markHtml=(text,rg)=>rg?emit([['',text]],rangesOf(text,rg)):esc(text);

/* --- sections repliables --- */
function computeFolds(lines,vendor){
  const n=lines.length, ind=new Int16Array(n), cm=new Uint8Array(n);
  for(let i=0;i<n;i++){
    const l=lines[i];
    if(!l.trim()){ ind[i]=-1; continue; }
    let k=0,w=0; while(k<l.length&&(l[k]===' '||l[k]==='\t')){ w+=l[k]==='\t'?4:1; k++; }
    ind[i]=w; const c=l[k]; cm[i]=(c===';'||c==='!'||c==='#')?1:0;
  }
  const regs=[], taken=new Set();
  const addReal=(s,e,kind,label)=>{ if(e<=s||taken.has(s)) return; taken.add(s); regs.push({s,e,kind,label,hideFrom:s+1}); };

  /* OmniSwitch : sections « ! Titre : » */
  if(vendor==='os'){
    const hdr=[]; for(let i=0;i<n;i++) if(/^!\s*[^!\s].*:\s*$/.test(lines[i])) hdr.push(i);
    hdr.forEach((s,k)=>{
      let e=(k+1<hdr.length?hdr[k+1]:n)-1; while(e>s&&ind[e]===-1) e--;
      addReal(s,e,'section',lines[s].replace(/^!\s*/,'').replace(/\s*:\s*$/,''));
    });
  }
  /* blocs par indentation (ProCurve : vlan, interface, router…) */
  for(let i=0;i<n;i++){
    if(ind[i]<0||cm[i]) continue;
    let j=i+1; while(j<n&&(ind[j]===-1||ind[j]>ind[i])) j++;
    let e=j-1; while(e>i&&ind[e]===-1) e--;
    if(e>i) addReal(i,e,'block',lines[i].trim());
  }
  /* groupes : séries de commandes/blocs consécutifs de même famille */
  const blkEnd=new Map(); regs.forEach(r=>{ if(r.kind==='block') blkEnd.set(r.s,r.e); });
  const units=[]; let i=0;
  while(i<n){
    if(ind[i]===-1){ i++; continue; }
    if(cm[i]||ind[i]>0){ units.push(null); i++; continue; }
    const e=blkEnd.has(i)?blkEnd.get(i):i;
    units.push({s:i,e,block:e>i,t:lines[i].trim()});
    i=e+1;
  }
  const wordKey=t=>{ const w=t.split(/\s+/); let k=w[0].toLowerCase(); if((k==='ip'||k==='ipv6')&&w[1]) k+=' '+w[1].toLowerCase(); return k; };
  const objKey=t=>{ let m;
    if((m=/^vlan\s+(\d+)\b/i.exec(t))) return 'vlan '+m[1];
    if((m=/^interfaces\s+(\S+)/i.exec(t))) return 'interfaces '+m[1];
    if((m=/^ip\s+interface\s+("[^"]*"|\S+)/i.exec(t))) return 'ip interface '+m[1];
    return null; };
  const seen=new Set(), groups=[];
  const runs=(keyFn,minRun)=>{
    let k=0;
    while(k<units.length){
      const u=units[k]; if(!u){ k++; continue; }
      const key=keyFn(u.t); if(!key){ k++; continue; }
      let m=k+1; while(m<units.length&&units[m]&&keyFn(units[m].t)===key) m++;
      const cnt=m-k;
      if(cnt>=minRun){
        const s=u.s, e=units[m-1].e, sig=s+':'+e;
        if(!seen.has(sig)){
          seen.add(sig);
          const nb=units.slice(k,m).filter(x=>x.block).length;
          groups.push({s,e,kind:'group',label:key,count:cnt,unit:nb===cnt?'blocs':(nb===0?'lignes':'éléments'),hideFrom:s});
        }
      }
      k=m;
    }
  };
  if(vendor==='os') runs(objKey,2);
  runs(wordKey,3);

  const all=regs.concat(groups).sort((a,b)=>a.s-b.s||b.e-a.e||(a.kind==='group'?-1:1));
  const stack=[];
  all.forEach((r,idx)=>{
    r.idx=idx;
    while(stack.length&&!(stack[stack.length-1].s<=r.s&&stack[stack.length-1].e>=r.e)) stack.pop();
    r.parent=stack.length?stack[stack.length-1]:null;
    stack.push(r);
  });
  return all;
}

function analyze(path,text,f){
  const lines=text.split(/\r?\n/);
  const vendor=detectVendor(lines), rich=lines.length<=MAX_RICH;
  let maxLen=0; for(let i=0;i<lines.length;i++) if(lines[i].length>maxLen) maxLen=lines[i].length;
  const regions=rich?computeFolds(lines,vendor):[];
  const grpAt=new Map(), foldAt=new Map();
  regions.forEach((r,idx)=>{
    if(r.kind==='group'){ if(!grpAt.has(r.s)) grpAt.set(r.s,[]); grpAt.get(r.s).push(idx); }
    else foldAt.set(r.s,idx);
  });
  return {path,text,lines,size:f.size,mtime:f.mtime,vendor,rich,maxLen,regions,grpAt,foldAt,
          collapsed:new Set(),vis:null,pos:null,n:0,flash:-1,rg:null,matchLines:[],matchCount:0};
}

/* =====================================================================
   Visionneuse virtualisée
   d.vis : éléments affichés dans l'ordre (index de ligne >=0, ou -(région+1) pour un en-tête de groupe)
   d.pos : index de ligne -> position dans d.vis (-1 si masquée par un repli)
   ===================================================================== */
function rebuildVis(d){
  const n=d.lines.length, R=d.regions;
  let diff=null;
  if(d.collapsed.size){ diff=new Int32Array(n+2); d.collapsed.forEach(i=>{ const r=R[i]; diff[r.hideFrom]++; diff[r.e+1]--; }); }
  const vis=new Int32Array(n+R.length), pos=new Int32Array(n).fill(-1);
  let m=0, acc=0;
  for(let i=0;i<n;i++){
    const gs=d.grpAt.get(i);
    if(gs) for(const idx of gs){
      let a=R[idx].parent, hid=false;
      while(a){ if(d.collapsed.has(a.idx)){ hid=true; break; } a=a.parent; }
      if(!hid) vis[m++]=-(idx+1);
    }
    if(diff){ acc+=diff[i]; if(acc>0) continue; }
    pos[i]=m; vis[m++]=i;
  }
  d.vis=vis.subarray(0,m); d.pos=pos; d.n=m;
}
function renderRows(d,rs,re){
  const R=d.regions; let h='';
  for(let k=rs;k<re;k++){
    const it=d.vis[k];
    if(it<0){
      const idx=-it-1, r=R[idx], col=d.collapsed.has(idx);
      h+='<div class="vr grp" data-r="'+idx+'"><span class="f t">'+(col?'▸':'▾')+'</span><span class="l"></span><span class="c"><b>'+esc(r.label)+'</b> — '+r.count+' '+r.unit+'</span></div>';
      continue;
    }
    const l=d.lines[it];
    const ranges=d.rg?rangesOf(l,d.rg):[];
    const segs=d.rich?tokenize(l):[['',l]];
    const fi=d.foldAt.get(it), r=fi!==undefined?R[fi]:null, col=!!r&&d.collapsed.has(fi);
    h+='<div class="vr'+((r&&r.kind==='section')?' sec':'')+(it===d.flash?' flash':'')+'"'+(r?' data-r="'+fi+'"':'')+'><span class="f'+(r?' t':'')+'">'+(r?(col?'▸':'▾'):'')+'</span><span class="l">'+(it+1)+'</span><span class="c">'+emit(segs,ranges)+(col?'<span class="fd">… '+(r.e-r.hideFrom+1)+' lignes</span>':'')+'</span></div>';
  }
  return h;
}
function measureChar(){
  if(VW.charW) return VW.charW;
  const p=document.createElement('span'); p.className='vprobe'; p.textContent='M'.repeat(200);
  const b=$('#body'); b.appendChild(p);
  const w=p.getBoundingClientRect().width/200; b.removeChild(p);
  return VW.charW=(w>1?w:7.6);
}
function mountViewer(d){
  const b=$('#body'); b.innerHTML='<div class="vs"><div class="vw"></div></div>'; b.scrollTop=0;
  b.querySelector('.vs').style.minWidth=Math.ceil(100+Math.min(d.maxLen,5000)*measureChar())+'px';
  VW.on=true; VW.d=null; VW.rs=0; VW.re=0;
}
function setHeight(){ const vs=$('#body').querySelector('.vs'); if(vs&&doc) vs.style.height=(doc.n*ROW_H)+'px'; }
function updateViewer(force){
  const d=doc; if(!d||!VW.on) return;
  const b=$('#body'), vw=b.querySelector('.vw'); if(!vw) return;
  const top=b.scrollTop, hgt=b.clientHeight||600;
  const a=Math.max(0,Math.floor(top/ROW_H)), z=Math.min(d.n,Math.ceil((top+hgt)/ROW_H));
  const okT=VW.rs===0||a-VW.rs>=8, okB=VW.re>=d.n||VW.re-z>=8;
  if(!force&&VW.d===d&&a>=VW.rs&&z<=VW.re&&okT&&okB) return;   // la fenêtre rendue couvre déjà la zone visible
  const rs=Math.max(0,a-BUF), re=Math.min(d.n,z+BUF);
  vw.style.top=(rs*ROW_H)+'px'; vw.innerHTML=renderRows(d,rs,re);
  VW.d=d; VW.rs=rs; VW.re=re;
}
function refresh(){ rebuildVis(doc); setHeight(); updateViewer(true); }
function scrollToLine(i){
  const d=doc, p=d.pos[i];
  if(p>=0){ const b=$('#body'); b.scrollTop=Math.max(0,p*ROW_H-b.clientHeight/2+ROW_H/2); }
  updateViewer(true);
}
function revealLine(d,i){
  if(!d.collapsed.size) return;
  d.regions.forEach((r,idx)=>{ if(d.collapsed.has(idx)&&r.hideFrom<=i&&i<=r.e) d.collapsed.delete(idx); });
}
function revealMatches(d){
  const cl=[...d.collapsed]; if(!cl.length) return;
  for(const i of d.matchLines){
    for(let k=0;k<cl.length;k++){
      const idx=cl[k], r=d.regions[idx];
      if(r.hideFrom<=i&&i<=r.e){ d.collapsed.delete(idx); cl.splice(k,1); k--; }
    }
    if(!cl.length) break;
  }
}
function toggleRegion(idx){
  const d=doc, b=$('#body'); if(!d) return;
  const key=d.regions[idx].kind==='group'?-(idx+1):d.regions[idx].s;
  const at=()=>key<0?d.vis.indexOf(key):d.pos[key];
  const off=at()*ROW_H-b.scrollTop;                    // l'en-tête cliqué reste à la même place à l'écran
  if(d.collapsed.has(idx)) d.collapsed.delete(idx); else d.collapsed.add(idx);
  rebuildVis(d); setHeight();
  const ni=at(); if(ni>=0) b.scrollTop=Math.max(0,ni*ROW_H-off);
  updateViewer(true);
}
function runFind(){
  const d=doc; if(!d) return;
  const term=($('#ff')||{}).value||'';
  d.rg=term?new RegExp(reEsc(term),'gi'):null; d.matchLines=[]; d.matchCount=0; d.flash=-1;
  if(d.rg){
    const t=new RegExp(reEsc(term),'i');
    for(let i=0;i<d.lines.length;i++){ const l=d.lines[i]; if(t.test(l)){ d.matchLines.push(i); d.matchCount+=rangesOf(l,d.rg).length; } }
  }
  $('#fc').textContent=term?d.matchCount+' occ.':'';
  if(d.matchLines.length) revealMatches(d);
  rebuildVis(d); setHeight();
  if(d.matchLines.length) scrollToLine(d.matchLines[0]); else updateViewer(true);
}

async function openFile(path,line){
  const f=fileByPath.get(path); if(!f) return;
  const tok=++openSeq;
  try{
    let d=doc;
    if(!d||d.path!==path){ const text=await getText(f); if(tok!==openSeq) return; d=analyze(path,text,f); doc=d; }
    d.rg=null; d.matchLines=[]; d.matchCount=0; d.flash=line>0?line-1:-1;
    showingResults=false; dash.on=false; cur.file=path;
    if(renderedDir!==parent(path)){ cur.dir=parent(path); renderList(); } else markSel();
    const vh=$('#vh'); vh.hidden=false;
    vh.innerHTML='<span class="t">'+esc(path)+'</span><span class="tag">'+VN[d.vendor]+'</span>'+
      '<span class="m">'+fmt(d.size)+' · '+dt(d.mtime)+' · '+d.lines.length+' lignes'+(d.rich?'':' · coloration désactivée (fichier volumineux)')+'</span>'+
      '<span class="fld" style="margin-left:auto"><input type="text" id="ff" placeholder="Chercher dans le fichier…" style="width:220px"><button class="x" type="button" title="Effacer" hidden>×</button></span><span class="m" id="fc"></span>'+
      (d.regions.length?'<button class="sec" id="fa">Tout replier</button><button class="sec" id="ua">Tout déplier</button>':'')+
      '<button class="sec" id="cp">Copier</button><button class="sec" id="dl">Télécharger</button>';
    $('#ff').oninput=debounce(runFind,150);
    if(d.regions.length){
      $('#fa').onclick=()=>{ d.regions.forEach((r,i)=>d.collapsed.add(i)); refresh(); };
      $('#ua').onclick=()=>{ d.collapsed.clear(); refresh(); };
    }
    $('#cp').onclick=()=>navigator.clipboard.writeText(d.text).then(()=>{ $('#cp').textContent='Copié ✓'; setTimeout(()=>$('#cp').textContent='Copier',1200); });
    $('#dl').onclick=async()=>{ const fl=await f.get(); const a=document.createElement('a'); a.href=URL.createObjectURL(fl); a.download=base(path); a.click(); setTimeout(()=>URL.revokeObjectURL(a.href),5000); };
    mountViewer(d);
    if(line>0) revealLine(d,line-1);
    rebuildVis(d); setHeight();
    if(line>0) scrollToLine(line-1); else updateViewer(true);
  }catch(e){
    if(tok!==openSeq) return;
    doc=null; cur.file=null; VW.on=false; $('#vh').hidden=true;
    $('#body').innerHTML='<div class="err">'+esc(path)+' : '+esc(e.message)+'</div>';
  }
}

/* =====================================================================
   Recherche plein texte : regroupement par fichier, compteurs, CSV
   ===================================================================== */
/* ---------- barre de progression commune (recherche, tableau de bord) ---------- */
function progressHtml(label,done,total,t0,extra,curFile){
  const now=performance.now(), secs=(now-t0)/1000, pct=total?Math.min(100,done/total*100):0;
  const rate=secs>0.2?done/secs:0, eta=rate>0?Math.max(0,(total-done)/rate):null;
  const fmtS=s=>s<60?Math.ceil(s)+' s':Math.floor(s/60)+' min '+Math.round(s%60)+' s';
  return '<div class="prog"><div class="pbar"><i style="width:'+pct.toFixed(1)+'%"></i></div>'+
    '<div class="prow"><b>'+done+' / '+total+'</b> fichiers ('+pct.toFixed(0)+' %)'+(extra?' · '+extra:'')+
    (rate>1?' · '+Math.round(rate)+' fichiers/s':'')+(eta!=null&&done<total?' · reste ≈ '+fmtS(eta):'')+
    '<span style="flex:1"></span><button class="sec" data-a="pstop">Arrêter</button></div>'+
    (curFile?'<div class="pf" title="'+esc(curFile)+'">'+esc(curFile)+'</div>':'')+'</div>';
}
function makeTicker(label,b,getTotal,skipRender){
  let lastNote=0, lastFile='', lastExtra='';
  return (done,extra,file)=>{
    if(file) lastFile=file; if(extra!=null) lastExtra=extra;
    const now=performance.now();
    if(now-lastNote<150&&done<getTotal()) return;
    lastNote=now;
    if(skipRender&&skipRender()) return;             // ex. actualisation du tableau de bord : l'aperçu périodique gère déjà l'affichage
    b.innerHTML=progressHtml(label,done,getTotal(),t0Ref.t,lastExtra,lastFile);
  };
}
const t0Ref={t:0};

async function search(){
  const q=$('#q').value.trim(); if(!q) return;
  const b=$('#body'); dash.on=false; VW.on=false; VW.d=null; $('#vh').hidden=true; cur.file=null; doc=null; showingResults=false; markSel();
  let re, hre, pre;
  try{
    const rx=$('#rx').checked, fl=$('#cs').checked?'':'i', src=rx?q:reEsc(q);
    re=new RegExp(src,fl); hre=new RegExp(src,'g'+fl); pre=new RegExp(src,'m'+fl);
  }catch(e){ b.innerHTML='<div class="err">Regex invalide : '+esc(e.message)+'</div>'; return; }
  const scope=$('#sc').checked?cur.dir:'';
  const list=files.filter(f=>!scope||f.path.startsWith(scope+'/'));
  const namesOnly=$('#nm').checked, results=[];
  let i=0, scanned=0, skipped=0, total=0; stopFlag=false;
  let lastYield=performance.now();
  setBusy(true); t0Ref.t=performance.now();
  const tick1=makeTicker('Recherche',b,()=>list.length);
  async function worker(){
    while(!stopFlag&&total<MAX_HITS){
      const f=list[i++]; if(!f) break;
      const fr={file:f.path,hits:[],lines:new Map(),name:re.test(f.name)};
      if(!namesOnly){
        try{
          const text=await getText(f); scanned++;
          if(pre.test(text)){                          // un seul passage sur tout le texte : la plupart des fichiers s'arrêtent ici
            const ls=text.split(/\r?\n/);
            for(let n=0;n<ls.length&&total<MAX_HITS;n++)
              if(re.test(ls[n])){ fr.hits.push(n+1); fr.lines.set(n+1,ls[n].trim().slice(0,300)); total++; }
          }
        }catch{ skipped++; }
      }
      if(fr.hits.length||fr.name) results.push(fr);
      tick1(i,total+' résultat(s)',f.path);
      const now=performance.now();
      if(now-lastYield>12){ await tick(); lastYield=performance.now(); }   // rend la main au navigateur (UI fluide)
    }
  }
  await Promise.all(Array.from({length:8},worker));
  setBusy(false);
  results.sort((a,c)=>COLL.compare(a.file,c.file));
  lastSearch={q,hre,results,total,scanned,skipped,stopped:stopFlag,secs:((performance.now()-t0Ref.t)/1000).toFixed(1)};
  showingResults=true; renderResults();
}
function renderResults(){
  const S=lastSearch, b=$('#body');
  let h='<div class="rbar"><b>'+S.total+' résultat(s)</b><span>dans '+S.results.length+' fichier(s)</span><span class="m">'+S.scanned+' lus'+(S.skipped?' · '+S.skipped+' ignorés (binaires/trop gros)':'')+' · '+S.secs+' s'+(S.stopped?' · interrompu':'')+(S.total>=MAX_HITS?' · tronqué':'')+'</span><span style="flex:1"></span>'+
    '<button class="sec" data-a="rfold">Tout replier</button><button class="sec" data-a="runfold">Tout déplier</button>'+
    '<button class="sec" data-a="csv-hits">CSV résultats</button><button class="sec" data-a="csv-files">CSV fichiers</button></div>';
  if(!S.results.length) h+='<div class="note">Aucun résultat.</div>';
  S.results.forEach(fr=>{
    h+='<div class="rg"><div class="res-f" data-f="'+esc(fr.file)+'" data-l="'+(fr.hits[0]||0)+'"><span class="car">▾</span><span class="nm">'+esc(fr.file)+'</span>'+
       (fr.name?'<span class="tag">nom</span>':'')+(fr.hits.length?'<span class="cnt" title="occurrences">'+fr.hits.length+'</span>':'')+'</div><div class="rb">';
    fr.hits.forEach(k=>{
      h+='<div class="res-h" data-f="'+esc(fr.file)+'" data-l="'+k+'"><span class="ln">'+k+'</span><span class="tx">'+markHtml(fr.lines.get(k),S.hre)+'</span></div>';
    });
    h+='</div></div>';
  });
  b.innerHTML=h;
}
function csvCell(v){
  let s=String(v==null?'':v);
  if(typeof v==='string'&&/^[=+\-@\t\r]/.test(s)) s="'"+s;      // évite l'interprétation en formule dans Excel
  return '"'+s.replace(/"/g,'""')+'"';
}
function downloadCSV(name,rows){
  const csv='\ufeff'+rows.map(r=>r.map(csvCell).join(';')).join('\r\n');
  const a=document.createElement('a');
  a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'}));
  a.download=name; a.click(); setTimeout(()=>URL.revokeObjectURL(a.href),5000);
}
function csvHits(){
  const S=lastSearch; if(!S) return;
  const R=[['Fichier','Ligne','Texte']];
  S.results.forEach(fr=>{
    if(fr.name&&!fr.hits.length) R.push([fr.file,'','(nom de fichier)']);
    fr.hits.forEach(h=>R.push([fr.file,h,fr.lines.get(h)||'']));
  });
  downloadCSV('resultats-recherche.csv',R);
}
function csvFiles(){
  const S=lastSearch; if(!S) return;
  const R=[['Fichier','Occurrences','Nom correspondant']];
  S.results.forEach(fr=>R.push([fr.file,fr.hits.length,fr.name?'oui':'']));
  downloadCSV('resultats-par-fichier.csv',R);
}

/* =====================================================================
   Tableau de bord : synthèse du parc (modèles, ports, PoE, firmware, VLAN)
   - extraction légère par fichier (mise en cache), agrégation recalculée à la volée
   - le modèle / nombre de ports / PoE viennent, dans l'ordre : du catalogue utilisateur,
     de la table intégrée, des règles (hostname/fichier), puis de l'analyse de la config
   ===================================================================== */
/* Références produit courantes (intégrées, à vérifier ; le catalogue utilisateur est prioritaire).
   « ports » = ports d'accès (classe 24/48), hors uplinks. */
const BUILTIN={
  'J9776A':{name:'Aruba 2530-24G',ports:24,poe:false},          'J9775A':{name:'Aruba 2530-48G',ports:48,poe:false},
  'J9773A':{name:'Aruba 2530-24G-PoE+',ports:24,poe:true},      'J9772A':{name:'Aruba 2530-48G-PoE+',ports:48,poe:true},
  'J9726A':{name:'Aruba 2920-24G',ports:24,poe:false},          'J9728A':{name:'Aruba 2920-48G',ports:48,poe:false},
  'J9727A':{name:'Aruba 2920-24G-PoE+',ports:24,poe:true},      'J9729A':{name:'Aruba 2920-48G-PoE+',ports:48,poe:true},
  'JL253A':{name:'Aruba 2930F-24G-4SFP+',ports:24,poe:false},   'JL254A':{name:'Aruba 2930F-48G-4SFP+',ports:48,poe:false},
  'JL255A':{name:'Aruba 2930F-24G-PoE+-4SFP+',ports:24,poe:true},'JL256A':{name:'Aruba 2930F-48G-PoE+-4SFP+',ports:48,poe:true},
  'J9021A':{name:'HP 2810-24G',ports:24,poe:false},             'J9022A':{name:'HP 2810-48G',ports:48,poe:false}
};
const PORT_RE=/^[A-Za-z]{0,2}\d+(?:\/\d+){0,2}$/;
const POE_PC=/^\s*(?:no\s+)?(?:power-over-ethernet|poe-[a-z-]+)\b/i;
const PORT_CLASSES=[8,12,16,24,48];
const portClass=n=>{ for(let i=PORT_CLASSES.length-1;i>=0;i--){ const c=PORT_CLASSES[i]; if(c<=n&&n-c<=4) return c; } return n; };   // 52 -> 48, 26 -> 24, 10 -> 8…
const FACET_NAME={vendor:'Constructeur',model:'Modèle',ports:'Ports',poe:'PoE',fw:'Firmware',kind:'Topologie',vlan:'VLAN'};
const POE_COL={'PoE':'var(--ac)','Non PoE':'var(--mu)','Indéterminé':'var(--c-ip)'};
const rawCache=new Map();
const dash={raws:[],meta:null,dedupe:true,filter:null,devs:[],stats:null,on:false,unknown:new Set()};

function expandPorts(spec){
  const out=[];
  for(const part of spec.split(',')){
    const p=part.trim(); if(!p) continue;
    const m=/^(.*?)(\d+)-(?:\1)?(\d+)$/.exec(p);
    if(m&&+m[3]>=+m[2]&&+m[3]-+m[2]<300){ for(let k=+m[2];k<=+m[3];k++) out.push(m[1]+k); }
    else out.push(p);
  }
  return out;
}
/* extraction brute d'un fichier : identité, références produit, ports, VLAN, indices PoE */
function extractDevice(lines,vendor,path){
  const D={file:path,vendor,host:'',code:'',fw:'',members:new Map(),vc:new Set(),modules:[],ports:new Map(),vlans:new Map(),ips:[],poeEv:false,mtime:0};
  const addPorts=spec=>{
    for(const p of expandPorts(spec)){
      if(!PORT_RE.test(p)) continue;                    // ignore Trk1, lacp…
      const u=p.includes('/')?p.split('/')[0]:'1';      // unité = membre de stack / châssis de VC
      let s=D.ports.get(u); if(!s){ s=new Set(); D.ports.set(u,s); }
      s.add(p);
    }
  };
  let m;
  if(vendor==='os'){
    for(const raw of lines){
      const l=raw.trim(); if(!l||l[0]==='!') continue;
      if((m=/^system name\s+"?([^"]*?)"?\s*$/i.exec(l))){ D.host=m[1]; continue; }
      if((m=/^virtual-chassis\s+(?:configured-chassis-id|chassis-id)\s+(\d+)/i.exec(l))){ D.vc.add(m[1]); continue; }
      if(/^lanpower\b/i.test(l)){ D.poeEv=true; continue; }
      if((m=/^vlan\s+(\d+)(?:-(\d+))?\b(.*)$/i.exec(l))){
        const a=+m[1], b=m[2]?+m[2]:a, rest=m[3];
        if(b>=a&&b-a<=4094){
          const nm=/\bname\s+(?:"([^"]*)"|(\S+))/i.exec(rest)||[], name=nm[1]!=null?nm[1]:(nm[2]||'');
          for(let id=a;id<=b;id++) if(!D.vlans.has(id)||name) D.vlans.set(id,name||D.vlans.get(id)||'');
        }
        let x;
        if((x=/\bmembers\s+port\s+(\S+)/i.exec(rest))) addPorts(x[1]);
        else if((x=/\bport\s+default\s+(\S+)/i.exec(rest))) addPorts(x[1]);
        else if((x=/\b802\.1q\s+(\S+)/i.exec(rest))) addPorts(x[1]);
        continue;
      }
      if(/^ip interface\b/i.test(l)){ const a=/\baddress\s+(\d+(?:\.\d+){3})/i.exec(l); if(a) D.ips.push(a[1]); continue; }
      if((m=/^interfaces\s+(\S+)/i.exec(l))) addPorts(m[1]);
    }
  } else {
    let ctx=null;
    for(const l of lines){
      if(!l.trim()) continue;
      if(/^\s*[;!#]/.test(l)){
        if((m=/^;\s*(?:hp\s+)?(\S+)\s+Configuration Editor;\s*Created on release\s+#?(\S+)/i.exec(l))){ D.code=m[1].toUpperCase(); D.fw=m[2]; }
        continue;
      }
      if(POE_PC.test(l)) D.poeEv=true;
      if(/^\S/.test(l)){
        ctx=null;
        if((m=/^hostname\s+"?([^"]*?)"?\s*$/i.exec(l))) D.host=m[1];
        else if((m=/^vlan\s+(\d+)\s*$/i.exec(l))){ ctx={k:'vlan',id:+m[1]}; if(!D.vlans.has(ctx.id)) D.vlans.set(ctx.id,''); }
        else if((m=/^interface\s+(\S+)/i.exec(l))){ ctx={k:'if'}; if(!/^vlan/i.test(m[1])) addPorts(m[1]); }
        else if(/^stacking\s*$/i.test(l)) ctx={k:'stack'};
        else if((m=/^stacking\s+member\s+(\d+)\s+type\s+"?([^"\s]+)"?/i.exec(l))) D.members.set(m[1],m[2].toUpperCase());
        else if((m=/^module\s+(\S+)\s+type\s+(\S+)/i.exec(l))) D.modules.push(m[2].toUpperCase());
      } else if(ctx){
        const t=l.trim(); let x;
        if(ctx.k==='vlan'){
          if((x=/^name\s+"?([^"]*?)"?\s*$/i.exec(t))) D.vlans.set(ctx.id,x[1]);
          else if((x=/^(?:untagged|tagged|forbid)\s+(.+)$/i.exec(t))) addPorts(x[1]);
          else if((x=/^ip address\s+(\d+(?:\.\d+){3})\s/i.exec(t+' '))) D.ips.push(x[1]);
        } else if(ctx.k==='stack'){
          if((x=/^member\s+(\d+)\s+type\s+"?([^"\s]+)"?/i.exec(t))) D.members.set(x[1],x[2].toUpperCase());
        }
      }
    }
  }
  return D;
}

/* ---------- catalogue utilisateur (localStorage) ---------- */
const CAT_DEFAULT='{\n  "models": {},\n  "rules": []\n}';
function parseCatalog(text){
  let o; try{ o=JSON.parse(text); }catch(e){ throw new Error('JSON invalide : '+e.message); }
  if(!o||typeof o!=='object'||Array.isArray(o)) throw new Error('La racine doit être un objet { "models": {…}, "rules": […] }');
  const c={models:{},rules:[]};
  if(o.models!=null){
    if(typeof o.models!=='object'||Array.isArray(o.models)) throw new Error('« models » doit être un objet');
    for(const [k,v] of Object.entries(o.models)){ if(v==null||typeof v!=='object'||Array.isArray(v)) throw new Error('models.'+k+' doit être un objet'); c.models[k.toUpperCase()]=v; }
  }
  if(o.rules!=null){
    if(!Array.isArray(o.rules)) throw new Error('« rules » doit être un tableau');
    o.rules.forEach((r,i)=>{
      if(!r||typeof r.match!=='string') throw new Error('rules['+i+'] : « match » (texte) requis');
      try{ c.rules.push({...r,re:new RegExp(r.match,'i')}); }catch(e){ throw new Error('rules['+i+'] : regex invalide ('+e.message+')'); }
    });
  }
  return c;
}
let catalogText=CAT_DEFAULT; try{ catalogText=localStorage.getItem('catalog')||CAT_DEFAULT; }catch{}
let catalog={models:{},rules:[]}; try{ catalog=parseCatalog(catalogText); }catch{}

/* identification d'une unité (membre de stack / châssis) */
function unitInfo(d,u,nUnits){
  const code=u.code; let m=null, src='';
  if(code&&catalog.models[code]){ m=catalog.models[code]; src='catalogue'; }
  else if(code&&BUILTIN[code]){ m=BUILTIN[code]; src='intégré'; }
  else{
    const subj=d.host+' '+d.file;
    for(const r of catalog.rules){ if(r.re.test(r.on==='file'?d.file:r.on==='host'?d.host:subj)){ m=r; src='règle'; break; } }
  }
  const known=!!(m&&(m.name||m.ports!=null||m.poe!=null));
  const name=(m&&m.name)||code||'Modèle inconnu';
  let ports=null, portsSrc='';
  if(m&&m.ports!=null&&m.ports!==''){ ports=+m.ports; portsSrc=src; }
  else if(u.reliable&&u.est>0){ ports=portClass(u.est); portsSrc='estimé'; }
  let poe=null;
  if(m&&m.poe!=null) poe=!!m.poe; else if(/poe/i.test(name)) poe=true; else if(d.poeEv&&nUnits===1) poe=true;
  return {id:u.id,code,name,ports,portsSrc,poe,known,src,est:u.est};
}
function unitsOf(d){
  const ids=new Set([...d.ports.keys(),...d.members.keys(),...d.vc]); if(!ids.size) ids.add('1');
  const sorted=[...ids].sort((a,b)=>a-b), first=sorted[0];
  return sorted.map(id=>{
    let code=d.members.get(id)||'';
    if(!code&&!d.members.size&&id===first) code=d.code||d.modules[0]||'';
    const est=d.ports.has(id)?d.ports.get(id).size:0;
    return unitInfo(d,{id,code,est,reliable:d.vendor!=='os'&&est>0},sorted.length);
  });
}

/* ---------- agrégation ---------- */
function addTo(map,label,dev){ let o=map.get(label); if(!o){ o={n:0,devs:new Set()}; map.set(label,o); } o.n++; o.devs.add(dev); }
function computeStats(devs){
  const F={vendor:new Map(),model:new Map(),ports:new Map(),poe:new Map(),fw:new Map(),kind:new Map(),vlan:new Map()};
  const S={devices:devs.length,units:0,portsTotal:0,portsUnknownUnits:0,unknownUnits:0,poeYes:0,poeUnk:0,F,vname:new Map(),unknown:new Set()};
  for(const d of devs){
    const U=unitsOf(d); d.U=U;
    d.vendorLabel=VN[d.vendor]; d.fwLabel=d.fw||'Inconnu';
    d.kind=U.length>1?(d.vendor==='os'?'Virtual Chassis':'Stack'):'Autonome';
    addTo(F.vendor,d.vendorLabel,d); addTo(F.fw,d.fwLabel,d); addTo(F.kind,d.kind,d);
    const names=new Map(), poes=new Map();
    for(const u of U){
      S.units++;
      addTo(F.model,u.name,d); names.set(u.name,(names.get(u.name)||0)+1);
      u.portsLabel=u.ports!=null?u.ports+' ports':'Non renseigné'; addTo(F.ports,u.portsLabel,d);
      if(u.ports!=null) S.portsTotal+=u.ports; else S.portsUnknownUnits++;
      u.poeLabel=u.poe===true?'PoE':u.poe===false?'Non PoE':'Indéterminé'; addTo(F.poe,u.poeLabel,d);
      poes.set(u.poeLabel,(poes.get(u.poeLabel)||0)+1);
      if(u.poe===true) S.poeYes++; else if(u.poe===null) S.poeUnk++;
      if(!u.known){ S.unknownUnits++; if(u.code) S.unknown.add(u.code); }
    }
    for(const [id,nm] of d.vlans){ addTo(F.vlan,String(id),d); if(nm&&!S.vname.has(id)) S.vname.set(id,nm); }
    d.modelTxt=[...names].map(([n,c])=>(c>1?c+'× ':'')+n).join(' + ');
    const known=U.filter(u=>u.ports!=null), sum=known.reduce((a,u)=>a+u.ports,0);
    d.portsTxt=known.length?(known.some(u=>u.portsSrc==='estimé')?'~':'')+sum+(known.length<U.length?'+?':''):'?';
    d.poeTxt=poes.size===1?[...poes.keys()][0]:[...poes].map(([k,c])=>c+' '+k).join(' / ');
  }
  return S;
}

/* ---------- analyse du dossier ---------- */
async function showDashboard(){
  const b=$('#body'), refreshing=dash.on;
  VW.on=false; VW.d=null; $('#vh').hidden=true; cur.file=null; doc=null; showingResults=false; markSel();
  if(!refreshing) dash.on=false;                   // 1er affichage : page d'attente, puis aperçus. Actualisation : le tableau reste à l'écran.
  const scope=$('#sc').checked?cur.dir:'';
  const list=files.filter(f=>!scope||f.path.startsWith(scope+'/'));
  const raws=[]; let i=0, done=0, skipped=0, none=0; stopFlag=false, gotPartial=false;
  let lastYield=performance.now(), lastPartial=0;
  const CACHED=list.filter(f=>f.size!=null&&rawCache.has(rootName+'|'+f.path+'|'+f.size+'|'+f.mtime)).length;
  setBusy(true); t0Ref.t=performance.now();
  const tick1=makeTicker('Analyse',b,()=>list.length,()=>refreshing||gotPartial);   // la barre texte s'efface dès qu'un aperçu du tableau existe
  async function worker(){
    while(!stopFlag){
      const f=list[i++]; if(!f) break;
      try{
        const text=await getText(f);
        const key=rootName+'|'+f.path+'|'+f.size+'|'+f.mtime;
        let D=rawCache.get(key);
        if(!D){ const lines=text.split(/\r?\n/); D=extractDevice(lines,detectVendor(lines),f.path); rawCache.set(key,D); }
        D.mtime=f.mtime;
        if(D.host||D.ports.size||D.vlans.size) raws.push(D); else none++;
      }catch{ skipped++; }
      done++;
      tick1(done,done+' analysé(s)',f.path);
      const now=performance.now();
      const due=!lastPartial?900:4500;               // 1er aperçu rapide (le tableau apparaît vite), puis cadence normale
      if(now-lastPartial>due&&raws.length){
        lastPartial=now; gotPartial=true;
        dash.raws=raws.slice(); dash.meta={total:list.length,skipped,none,stopped:stopFlag,partial:true};
        renderDash(progressHtml('Analyse',done,list.length,t0Ref.t,done+' analysé(s)',f.path));
      }
      if(now-lastYield>12){ await tick(); lastYield=performance.now(); }
    }
  }
  if(!refreshing&&CACHED>0&&CACHED<list.length) b.innerHTML='<div class="note">'+CACHED+' / '+list.length+' fichiers déjà en cache…</div>';
  await Promise.all(Array.from({length:6},worker));
  setBusy(false);
  dash.raws=raws; dash.meta={total:list.length,skipped,none,stopped:stopFlag}; dash.filter=null;
  renderDash();
}

/* ---------- rendu ---------- */
const byCount=(a,b)=>b[1].n-a[1].n||COLL.compare(a[0],b[0]);
function barsHtml(facet,entries,sel){
  const max=Math.max(1,...entries.map(e=>e[1].n));
  return entries.map(([label,o,disp])=>'<div class="bar'+(sel&&sel.f===facet&&sel.v===label?' on':'')+'" data-facet="'+facet+'" data-val="'+esc(label)+'" title="'+esc(disp||label)+'"><span class="lbl">'+esc(disp||label)+'</span><span class="trk"><i style="width:'+(o.n/max*100).toFixed(1)+'%"></i></span><span class="n">'+o.n+'</span></div>').join('')||'<div class="hint">—</div>';
}
function renderDash(progress){
  const b=$('#body'), st=b.scrollTop, hadDevices=!!(dash.stats&&dash.stats.devices);
  VW.on=false; showingResults=false; dash.on=true;
  let devs=dash.raws;
  if(dash.dedupe){                                                   // une seule config par équipement : la plus récente
    const m=new Map();
    for(const d of devs){
      const k=d.host?d.vendor+'|'+d.host.toLowerCase():'f|'+d.file, o=m.get(k);
      if(!o||d.mtime>o.mtime||(d.mtime===o.mtime&&d.file>o.file)) m.set(k,d);
    }
    devs=[...m.values()];
  }
  const S=computeStats(devs);
  if(!S.devices&&progress&&hadDevices){ b.scrollTop=st; return; }   // actualisation : le tableau précédent reste affiché le temps du 1er aperçu
  dash.devs=devs; dash.stats=S; dash.unknown=S.unknown;
  const M=dash.meta||{}, F=S.F;
  if(dash.filter&&dash.filter.f!=='all'&&!(F[dash.filter.f]&&F[dash.filter.f].has(dash.filter.v))) dash.filter=null;
  const sel=progress?null:dash.filter;
  let h=progress||'';
  if(!progress) h+='<div class="dbar"><label><input type="checkbox" id="dd"'+(dash.dedupe?' checked':'')+'> dernière sauvegarde par équipement</label><span class="m">'+
    dash.raws.length+' configuration(s) analysée(s)'+(M.none?' · '+M.none+' sans configuration reconnue':'')+(M.skipped?' · '+M.skipped+' ignorée(s)':'')+(M.stopped?' · analyse interrompue':'')+
    '</span><span style="flex:1"></span><button class="sec" data-a="dcat">Catalogue matériel…</button><button class="sec" data-a="dcsv">Export CSV</button><button class="sec" data-a="dref">Actualiser</button></div>';
  if(!S.devices){
    b.innerHTML=h+'<div class="note">'+(progress?'En attente des premiers résultats…':'Aucune configuration reconnue dans ce dossier (ProCurve / OmniSwitch).')+'</div>';
    if(!progress) wireDash();
    b.scrollTop=st; return;
  }
  const stacks=(F.kind.get('Stack')?F.kind.get('Stack').n:0)+(F.kind.get('Virtual Chassis')?F.kind.get('Virtual Chassis').n:0);
  const kp=(v,l,s)=>'<div class="kpi"><b>'+v+'</b><span>'+l+'</span>'+(s?'<small>'+s+'</small>':'')+'</div>';
  h+='<div class="kpis">'+
    kp(S.devices,'Équipements',dash.dedupe&&dash.raws.length!==S.devices?dash.raws.length+' configurations lues':'')+
    kp(S.units,'Switchs physiques (unités)',stacks?stacks+' stack / VC':'')+
    kp(F.model.size,'Modèles distincts',S.unknownUnits?S.unknownUnits+' unité(s) à identifier':'')+
    kp(S.portsTotal,'Ports (total connu)',S.portsUnknownUnits?S.portsUnknownUnits+' unité(s) sans nombre de ports':'')+
    kp(S.poeYes,'Switchs PoE',S.poeUnk?S.poeUnk+' indéterminé(s)':'')+
    kp(F.fw.size,'Versions de firmware')+'</div>';
  if(S.unknownUnits||S.poeUnk||S.portsUnknownUnits)
    h+='<div class="warn">⚠️ <span><b>'+S.unknownUnits+'</b> unité(s) sans modèle identifié, <b>'+S.portsUnknownUnits+'</b> sans nombre de ports, <b>'+S.poeUnk+'</b> avec PoE indéterminé. Complète le catalogue pour affiner ces chiffres.</span><button class="sec" data-a="dcat">Catalogue matériel…</button></div>';
  const card=(t,inner,scroll)=>'<section class="card"><h3>'+t+'</h3>'+(scroll?'<div class="scroll">':'')+inner+(scroll?'</div>':'')+'</section>';
  const portsE=[...F.ports].sort((a,c)=>{ const x=parseInt(a[0]), y=parseInt(c[0]); return isNaN(x)?1:isNaN(y)?-1:x-y; });
  const vlanE=[...F.vlan].sort(byCount).slice(0,15).map(([id,o])=>[id,o,'VLAN '+id+(S.vname.get(+id)?' — '+S.vname.get(+id):'')]);
  const pt=F.poe, tot=[...pt.values()].reduce((a,o)=>a+o.n,0)||1, order=['PoE','Non PoE','Indéterminé'];
  let acc=0; const stops=order.map(k=>{ const n=pt.has(k)?pt.get(k).n:0, from=acc/tot*100; acc+=n; return POE_COL[k]+' '+from.toFixed(2)+'% '+(acc/tot*100).toFixed(2)+'%'; });
  const poeH='<div class="poe"><div class="donut" style="background:conic-gradient('+stops.join(',')+')"></div><div class="leg">'+
    order.filter(k=>pt.has(k)).map(k=>'<div class="bar lg'+(sel&&sel.f==='poe'&&sel.v===k?' on':'')+'" data-facet="poe" data-val="'+k+'"><span class="dot" style="background:'+POE_COL[k]+'"></span><span class="lbl">'+k+'</span><span class="n">'+pt.get(k).n+' ('+Math.round(pt.get(k).n/tot*100)+' %)</span></div>').join('')+'</div></div>';
  h+='<div class="dgrid">'+
    card('Constructeurs',barsHtml('vendor',[...F.vendor].sort(byCount),sel))+
    card('Modèles <small>(par unité)</small>',barsHtml('model',[...F.model].sort(byCount),sel),true)+
    card('Ports par switch <small>(par unité)</small>',barsHtml('ports',portsE,sel))+
    card('PoE <small>(par unité)</small>',poeH)+
    card('Firmware',barsHtml('fw',[...F.fw].sort(byCount),sel),true)+
    card('Topologie',barsHtml('kind',[...F.kind].sort(byCount),sel))+
    card('VLAN les plus présents <small>(nb d\'équipements)</small>',barsHtml('vlan',vlanE,sel),true)+
  '</div>'+(progress?'':'<div id="dlist">'+dashListHtml()+'</div>');
  b.innerHTML=h;
  if(!progress) wireDash();
  b.scrollTop=st;
}
function wireDash(){
  const dd=$('#dd'); if(dd) dd.onchange=()=>{ dash.dedupe=dd.checked; dash.filter=null; renderDash(); };
}
function dashSelection(){
  const S=dash.stats, f=dash.filter; if(!S||!f) return null;
  if(f.f==='all') return {title:'Tous les équipements',list:dash.devs};
  const o=S.F[f.f]&&S.F[f.f].get(f.v);
  return {title:FACET_NAME[f.f]+' : '+(f.f==='vlan'?'VLAN '+f.v:f.v),list:o?[...o.devs]:[]};
}
function dashListHtml(){
  const sl=dashSelection();
  if(!sl) return '<div class="hint">Clique sur une barre pour lister les équipements correspondants. <button class="sec" data-a="dall">Afficher tous les équipements</button></div>';
  const list=sl.list.slice().sort((a,c)=>COLL.compare(a.host||a.file,c.host||c.file)), CAP=500;
  let h='<div class="dhead"><b>'+esc(sl.title)+'</b><span class="m">'+list.length+' équipement(s)'+(list.length>CAP?' — '+CAP+' premiers affichés (export CSV pour la liste complète)':'')+'</span><button class="sec" data-a="dclear">Effacer le filtre</button></div>'+
    '<table class="dl"><thead><tr><th>Hostname</th><th>Type</th><th>Modèle(s)</th><th>Unités</th><th>Ports</th><th>PoE</th><th>Firmware</th><th>IP</th><th>Fichier</th></tr></thead><tbody>';
  for(const d of list.slice(0,CAP)){
    const src=d.U.map(u=>u.name+' ['+u.src+']').join(', ')||'';
    h+='<tr><td class="mono">'+esc(d.host||'—')+'</td><td>'+esc(d.vendorLabel)+'</td><td title="'+esc(src)+'">'+esc(d.modelTxt)+'</td><td>'+d.U.length+'</td><td title="'+(d.portsTxt[0]==='~'?'estimé d\'après la config':'')+'">'+esc(d.portsTxt)+'</td><td>'+esc(d.poeTxt)+'</td><td class="mono">'+esc(d.fwLabel)+'</td><td class="mono">'+esc(d.ips[0]||'—')+'</td>'+
       '<td><a data-f="'+esc(d.file)+'" data-l="0" title="'+esc(d.file)+'">'+esc(base(d.file))+'</a></td></tr>';
  }
  return h+'</tbody></table>';
}
function pickFacet(f,v){
  const cu=dash.filter;
  dash.filter=(cu&&cu.f===f&&cu.v===v)?null:{f,v};
  refreshDashList();
}
function refreshDashList(){
  const f=dash.filter;
  document.querySelectorAll('#body .bar').forEach(e=>e.classList.toggle('on',!!f&&e.dataset.facet===f.f&&e.dataset.val===f.v));
  const l=$('#dlist'); if(!l) return;
  l.innerHTML=dashListHtml();
  if(f&&l.scrollIntoView) l.scrollIntoView({behavior:'smooth',block:'nearest'});
}
function csvDash(){
  const sl=dashSelection(), list=sl?sl.list:dash.devs; if(!dash.stats) return;
  const R=[['Hostname','Type','Modèle(s)','Unités','Ports','PoE','Firmware','Topologie','IP','Nb VLAN','Fichier','Date']];
  list.slice().sort((a,c)=>COLL.compare(a.host||a.file,c.host||c.file)).forEach(d=>R.push([d.host,d.vendorLabel,d.modelTxt,d.U.length,d.portsTxt,d.poeTxt,d.fwLabel,d.kind,d.ips[0]||'',d.vlans.size,d.file,d.mtime?new Date(d.mtime).toISOString().slice(0,16).replace('T',' '):'']));
  downloadCSV('tableau-de-bord.csv',R);
}

/* ---------- boîte de dialogue : catalogue matériel ---------- */
function openCatalog(){ $('#cat-t').value=catalogText; $('#cat-e').textContent=''; $('#cat').showModal(); }
function saveCatalog(){
  const text=$('#cat-t').value;
  try{ catalog=parseCatalog(text); }catch(e){ $('#cat-e').textContent=e.message; return; }
  catalogText=text; try{ localStorage.setItem('catalog',text); }catch{}
  $('#cat').close();
  if(dash.on) renderDash();
}
function addUnknownToCatalog(){
  let o; try{ o=JSON.parse($('#cat-t').value); }catch(e){ $('#cat-e').textContent='JSON invalide : '+e.message; return; }
  if(!o||typeof o!=='object'||Array.isArray(o)) o={};
  if(!o.models||typeof o.models!=='object'||Array.isArray(o.models)) o.models={};
  const have=new Set(Object.keys(o.models).map(k=>k.toUpperCase())); let n=0;
  for(const code of dash.unknown) if(!have.has(code)){ o.models[code]={name:'',ports:null,poe:null}; n++; }
  $('#cat-t').value=JSON.stringify(o,null,2);
  $('#cat-e').textContent=n?n+' référence(s) ajoutée(s) : renseigne « name », « ports » et « poe », puis enregistre.':'Aucune nouvelle référence à ajouter.';
}

/* =====================================================================
   Événements globaux
   ===================================================================== */
$('#body').addEventListener('click',e=>{
  const t=e.target; let el;
  if((el=t.closest('.vr .f.t'))||(el=t.closest('.vr.grp'))){ toggleRegion(+el.closest('.vr').dataset.r); return; }
  if((el=t.closest('[data-a]'))){
    switch(el.dataset.a){
      case 'rfold': document.querySelectorAll('.rg').forEach(g=>g.classList.add('c')); break;
      case 'runfold': document.querySelectorAll('.rg').forEach(g=>g.classList.remove('c')); break;
      case 'csv-hits': csvHits(); break;
      case 'csv-files': csvFiles(); break;
      case 'dcat': openCatalog(); break;
      case 'dcsv': csvDash(); break;
      case 'dref': showDashboard(); break;
      case 'dall': dash.filter={f:'all',v:''}; refreshDashList(); break;
      case 'dclear': dash.filter=null; refreshDashList(); break;
      case 'pstop': stopFlag=true; break;
    }
    return;
  }
  if((el=t.closest('.bar'))){ pickFacet(el.dataset.facet,el.dataset.val); return; }
  if((el=t.closest('.res-f .car'))){ el.closest('.rg').classList.toggle('c'); return; }
  if((el=t.closest('[data-f]'))){ openFile(el.dataset.f,+el.dataset.l||0); return; }
});
$('#body').addEventListener('scroll',()=>{
  if(!VW.on||VW.raf) return;
  VW.raf=requestAnimationFrame(()=>{ VW.raf=0; updateViewer(false); });
},{passive:true});
if(typeof ResizeObserver!=='undefined') new ResizeObserver(()=>{ if(VW.on) updateViewer(true); }).observe($('#body'));

$('#go').onclick=search; $('#stop').onclick=()=>{ stopFlag=true; };
$('#db').onclick=showDashboard;
$('#cat-save').onclick=saveCatalog; $('#cat-cancel').onclick=()=>$('#cat').close(); $('#cat-unk').onclick=addUnknownToCatalog;
$('#cat-exp').onclick=()=>{ const a=document.createElement('a'); a.href=URL.createObjectURL(new Blob([$('#cat-t').value],{type:'application/json'})); a.download='catalogue-materiel.json'; a.click(); setTimeout(()=>URL.revokeObjectURL(a.href),5000); };
$('#cat-imp').onclick=()=>$('#cat-file').click();
$('#cat-file').onchange=async e=>{ const f=e.target.files[0]; if(f){ $('#cat-t').value=await f.text(); $('#cat-e').textContent=''; } e.target.value=''; };
$('#q').onkeydown=e=>{ if(e.key==='Enter') search(); };
$('#q').oninput=()=>{ if(!$('#q').value&&showingResults) empty(); };

/* cache : case « cache disque » + bouton de purge */
$('#pc').checked=persist;
$('#pc').onchange=async()=>{
  persist=$('#pc').checked; try{ localStorage.setItem('persist',persist?'1':'0'); }catch{}
  if(!persist){ putQ.length=0; try{ await idbReq('txt','readwrite',s=>{ s.clear(); }); }catch{} }
  setInfo(persist?'Cache disque activé':'Cache disque désactivé et vidé'); setTimeout(()=>setInfo(),2500);
};
$('#clr').onclick=async()=>{ await clearCache(true); setInfo('Cache vidé'); setTimeout(()=>setInfo(),2500); };

/* croix d'effacement (délégation) + Échap */
document.addEventListener('input',e=>{ const i=e.target; if(i.matches('.fld input')) i.nextElementSibling.hidden=!i.value; });
document.addEventListener('click',e=>{
  const x=e.target.closest('.fld .x'); if(!x) return;
  const i=x.previousElementSibling; i.value=''; x.hidden=true; i.focus();
  i.dispatchEvent(new Event('input',{bubbles:true}));
});
document.addEventListener('keydown',e=>{
  if(e.key==='Escape'&&e.target.matches('.fld input')&&e.target.value){ e.target.value=''; e.target.dispatchEvent(new Event('input',{bubbles:true})); }
});

/* colonne de gauche redimensionnable */
(function(){
  const side=$('#side'), rz=$('#resizer');
  try{ const w=+localStorage.getItem('sideW'); if(w) side.style.width=w+'px'; }catch{}
  rz.onmousedown=e=>{
    e.preventDefault(); rz.classList.add('on');
    const mv=ev=>{ side.style.width=Math.min(Math.max(ev.clientX,180),window.innerWidth-200)+'px'; };
    const up=()=>{ rz.classList.remove('on'); document.removeEventListener('mousemove',mv); document.removeEventListener('mouseup',up);
      try{ localStorage.setItem('sideW',parseInt(side.style.width)); }catch{} };
    document.addEventListener('mousemove',mv); document.addEventListener('mouseup',up);
  };
})();

/* ---------- démarrage ---------- */
$('#body').innerHTML='<div class="empty"><p><b>Aucun dossier chargé.</b></p><p>Clique sur « Choisir un dossier… » et sélectionne ton lecteur réseau ou l\'un de ses répertoires.</p>'+
  (HAS_FSA?'':'<p style="font-size:12px">Firefox peut afficher « Envoyer N fichiers ? » : rien n\'est envoyé, la lecture reste locale.</p>')+'</div>';
restoreHandle();
