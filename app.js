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
  setInfo(); $('#q').disabled=false; $('#go').disabled=false;
  clearFilter(); renderList(); empty();
  pruneCache();
}
function setInfo(t){ $('#info').textContent=t!=null?t:(rootName?rootName+' — '+files.length+' fichiers':''); }
function empty(){ VW.on=false; VW.d=null; showingResults=false; $('#vh').hidden=true; $('#body').innerHTML='<div class="empty">Sélectionne un fichier ou lance une recherche.</div>'; }
function setBusy(on){ busy=on; $('#go').hidden=on; $('#stop').hidden=!on; }

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
    showingResults=false; cur.file=path;
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
async function search(){
  const q=$('#q').value.trim(); if(!q) return;
  const b=$('#body'); VW.on=false; VW.d=null; $('#vh').hidden=true; cur.file=null; doc=null; showingResults=false; markSel();
  let re, hre, pre;
  try{
    const rx=$('#rx').checked, fl=$('#cs').checked?'':'i', src=rx?q:reEsc(q);
    re=new RegExp(src,fl); hre=new RegExp(src,'g'+fl); pre=new RegExp(src,'m'+fl);
  }catch(e){ b.innerHTML='<div class="err">Regex invalide : '+esc(e.message)+'</div>'; return; }
  const scope=$('#sc').checked?cur.dir:'';
  const list=files.filter(f=>!scope||f.path.startsWith(scope+'/'));
  const namesOnly=$('#nm').checked, results=[];
  let i=0, scanned=0, skipped=0, total=0; stopFlag=false;
  let lastYield=performance.now(), lastNote=0;
  setBusy(true); const t0=performance.now();
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
      const now=performance.now();
      if(now-lastNote>150){ lastNote=now; b.innerHTML='<div class="note">Recherche… '+i+' / '+list.length+' fichiers · '+total+' résultat(s)</div>'; }
      if(now-lastYield>12){ await tick(); lastYield=performance.now(); }   // rend la main au navigateur (UI fluide)
    }
  }
  await Promise.all(Array.from({length:8},worker));
  setBusy(false);
  results.sort((a,c)=>COLL.compare(a.file,c.file));
  lastSearch={q,hre,results,total,scanned,skipped,stopped:stopFlag,secs:((performance.now()-t0)/1000).toFixed(1)};
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
    }
    return;
  }
  if((el=t.closest('.res-f .car'))){ el.closest('.rg').classList.toggle('c'); return; }
  if((el=t.closest('[data-f]'))){ openFile(el.dataset.f,+el.dataset.l||0); return; }
});
$('#body').addEventListener('scroll',()=>{
  if(!VW.on||VW.raf) return;
  VW.raf=requestAnimationFrame(()=>{ VW.raf=0; updateViewer(false); });
},{passive:true});
if(typeof ResizeObserver!=='undefined') new ResizeObserver(()=>{ if(VW.on) updateViewer(true); }).observe($('#body'));

$('#go').onclick=search; $('#stop').onclick=()=>{ stopFlag=true; };
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
