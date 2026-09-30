/* =====================================================================
   Explorateur de configs — ProCurve / OmniSwitch
   ===================================================================== */
const $=s=>document.querySelector(s);
const esc=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const reEsc=s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const fmt=n=>n<1024?n+' o':n<1048576?(n/1024).toFixed(1)+' Ko':(n/1048576).toFixed(1)+' Mo';
const dt=t=>new Date(t).toLocaleString('fr-FR',{dateStyle:'short',timeStyle:'short'});
const parent=p=>p.includes('/')?p.slice(0,p.lastIndexOf('/')):'';
const base=p=>p.slice(p.lastIndexOf('/')+1);
const MAX_FILE=8*1024*1024, MAX_HITS=2000, MAX_RICH=40000, HAS_FSA=!!window.showDirectoryPicker;
const VN={pc:'ProCurve / ArubaOS-Switch',os:'OmniSwitch',gen:'Générique'};

let files=[], tree=new Map(), rootName='', cur={dir:'',file:null}, stopFlag=false, showingResults=false;
let doc=null, lastSearch=null;

/* ---------- index ---------- */
function build(list,name){
  files=list; rootName=name; tree=new Map([['',{d:new Set(),f:[]}]]);
  for(const f of files){
    const p=f.path.split('/'); let acc='';
    for(let i=0;i<p.length-1;i++){
      const par=acc; acc+=(acc?'/':'')+p[i];
      if(!tree.has(acc)) tree.set(acc,{d:new Set(),f:[]});
      tree.get(par).d.add(acc);
    }
    tree.get(acc).f.push(f);
  }
  cur={dir:'',file:null}; doc=null; lastSearch=null;
  $('#info').textContent=name+' — '+files.length+' fichiers';
  $('#q').disabled=false; $('#go').disabled=false;
  renderList(); empty();
}
function empty(){ showingResults=false; $('#vh').hidden=true; $('#body').innerHTML='<div class="empty">Sélectionne un fichier ou lance une recherche.</div>'; }
function setBusy(on){ $('#go').hidden=on; $('#stop').hidden=!on; }

/* ---------- sources : File System Access API (Chrome/Edge) ou <input webkitdirectory> (Firefox) ---------- */
async function walk(dirHandle,prefix,out){
  const jobs=[];
  for await(const [name,h] of dirHandle.entries()){
    const path=prefix?prefix+'/'+name:name;
    if(h.kind==='directory') jobs.push(walk(h,path,out));
    else jobs.push(h.getFile().then(fl=>out.push({path,size:fl.size,mtime:fl.lastModified,get:async()=>h.getFile()})).catch(()=>{}));
  }
  await Promise.all(jobs);
}
async function loadHandle(h){
  $('#info').textContent='Lecture de l\'arborescence…';
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

/* dernier dossier mémorisé (Chrome/Edge) */
function idb(){return new Promise((res,rej)=>{const r=indexedDB.open('cfgbrowser',1);r.onupgradeneeded=()=>r.result.createObjectStore('h');r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)})}
async function saveHandle(h){try{const db=await idb();db.transaction('h','readwrite').objectStore('h').put(h,'last')}catch{}}
async function restoreHandle(){
  if(!HAS_FSA) return;
  try{
    const db=await idb();
    const h=await new Promise(res=>{const r=db.transaction('h').objectStore('h').get('last');r.onsuccess=()=>res(r.result)});
    if(!h) return;
    const b=$('#reopen'); b.hidden=false; b.textContent='Rouvrir « '+h.name+' »';
    b.onclick=async()=>{ if(await h.requestPermission({mode:'read'})==='granted'){ b.hidden=true; loadHandle(h);} };
  }catch{}
}

/* ---------- liste des fichiers ---------- */
function renderList(){
  const node=tree.get(cur.dir); if(!node) return;
  const q=$('#filter').value.toLowerCase();
  const parts=cur.dir?cur.dir.split('/'):[]; let acc='';
  let c='<a data-d="">'+esc(rootName)+'</a>';
  parts.forEach(p=>{acc+=(acc?'/':'')+p; c+=' / <a data-d="'+esc(acc)+'">'+esc(p)+'</a>';});
  $('#crumbs').innerHTML=c;
  $('#crumbs').querySelectorAll('a').forEach(a=>a.onclick=()=>{cur.dir=a.dataset.d;$('#filter').value='';renderList()});
  let h=cur.dir?'<div class="row" data-up="1"><span>⬆️</span><span class="n">..</span></div>':'';
  [...node.d].sort((a,b)=>a.localeCompare(b,'fr',{sensitivity:'base'})).forEach(d=>{
    const n=d.slice(d.lastIndexOf('/')+1);
    if(!q||n.toLowerCase().includes(q)) h+='<div class="row" data-dir="'+esc(d)+'"><span>📁</span><span class="n">'+esc(n)+'</span></div>';
  });
  [...node.f].sort((a,b)=>a.path.localeCompare(b.path,'fr',{sensitivity:'base'})).forEach(f=>{
    const n=base(f.path);
    if(!q||n.toLowerCase().includes(q)) h+='<div class="row'+(f.path===cur.file?' sel':'')+'" data-f="'+esc(f.path)+'" title="'+esc(n)+'"><span>📄</span><span class="n">'+esc(n)+'<span class="m">'+fmt(f.size)+' · '+dt(f.mtime)+'</span></span></div>';
  });
  $('#list').innerHTML=h||'<div class="note">Vide</div>';
  $('#list').querySelectorAll('.row').forEach(r=>r.onclick=()=>{
    if(r.dataset.up){cur.dir=parent(cur.dir);$('#filter').value='';renderList();}
    else if(r.dataset.dir!==undefined){cur.dir=r.dataset.dir;$('#filter').value='';renderList();}
    else openFile(r.dataset.f,0);
  });
}
$('#filter').oninput=renderList;

/* ---------- lecture ---------- */
async function readText(f){
  const file=await f.get();
  if(file.size>MAX_FILE) throw new Error('fichier trop volumineux ('+Math.round(file.size/1048576)+' Mo)');
  const buf=new Uint8Array(await file.arrayBuffer());
  if(buf.subarray(0,4096).includes(0)) throw new Error('fichier binaire');
  try{ return new TextDecoder('utf-8',{fatal:true}).decode(buf); }
  catch{ return new TextDecoder('windows-1252').decode(buf); }
}

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
  return {path,text,lines,size:f.size,mtime:f.mtime,vendor,rich,segs:[],rows:[],collapsed:new Set(),
          regions:rich?computeFolds(lines,vendor):[]};
}

/* =====================================================================
   Visionneuse
   ===================================================================== */
async function openFile(path,line){
  const f=files.find(x=>x.path===path); if(!f) return;
  try{
    if(!doc||doc.path!==path){ doc=analyze(path,await readText(f),f); }
    const d=doc;
    showingResults=false; cur.file=path; cur.dir=parent(path); renderList();
    const vh=$('#vh'); vh.hidden=false;
    vh.innerHTML='<span class="t">'+esc(path)+'</span><span class="tag">'+VN[d.vendor]+'</span>'+
      '<span class="m">'+fmt(d.size)+' · '+dt(d.mtime)+' · '+d.lines.length+' lignes'+(d.rich?'':' · coloration désactivée (fichier volumineux)')+'</span>'+
      '<span class="fld" style="margin-left:auto"><input type="text" id="ff" placeholder="Chercher dans le fichier…" style="width:220px"><button class="x" type="button" title="Effacer" hidden>×</button></span><span class="m" id="fc"></span>'+
      (d.regions.length?'<button class="sec" id="fa">Tout replier</button><button class="sec" id="ua">Tout déplier</button>':'')+
      '<button class="sec" id="cp">Copier</button><button class="sec" id="dl">Télécharger</button>';
    $('#ff').oninput=()=>draw(0);
    if(d.regions.length){
      $('#fa').onclick=()=>{ d.regions.forEach((r,i)=>d.collapsed.add(i)); applyFolds(); };
      $('#ua').onclick=()=>{ d.collapsed.clear(); applyFolds(); };
    }
    $('#cp').onclick=()=>navigator.clipboard.writeText(d.text).then(()=>{$('#cp').textContent='Copié ✓';setTimeout(()=>$('#cp').textContent='Copier',1200)});
    $('#dl').onclick=async()=>{const fl=await f.get();const a=document.createElement('a');a.href=URL.createObjectURL(fl);a.download=base(path);a.click();setTimeout(()=>URL.revokeObjectURL(a.href),5000)};
    draw(line);
  }catch(e){ doc=null; cur.file=null; $('#vh').hidden=true; $('#body').innerHTML='<div class="err">'+esc(path)+' : '+esc(e.message)+'</div>'; }
}

function revealLine(i){
  const d=doc; if(!d.collapsed.size) return;
  d.regions.forEach((r,idx)=>{ if(d.collapsed.has(idx)&&r.hideFrom<=i&&i<=r.e) d.collapsed.delete(idx); });
}
function draw(line){
  const d=doc, term=($('#ff')||{}).value||'', rg=term?new RegExp(reEsc(term),'gi'):null;
  if(line>0) revealLine(line-1);
  const grpAt=new Map(), foldAt=new Map();
  d.regions.forEach((r,idx)=>{
    if(r.kind==='group'){ if(!grpAt.has(r.s)) grpAt.set(r.s,[]); grpAt.get(r.s).push(idx); }
    else foldAt.set(r.s,idx);
  });
  let h='<table class="code">', cnt=0, first=0;
  for(let i=0;i<d.lines.length;i++){
    const l=d.lines[i];
    (grpAt.get(i)||[]).forEach(idx=>{
      const r=d.regions[idx];
      h+='<tr class="grp" data-r="'+idx+'"><td class="f t">▾</td><td class="l"></td><td class="c"><b>'+esc(r.label)+'</b> — '+r.count+' '+r.unit+'</td></tr>';
    });
    const ranges=rg?rangesOf(l,rg):[];
    if(ranges.length){ cnt+=ranges.length; if(!first) first=i+1; revealLine(i); }
    let segs; if(d.rich) segs=d.segs[i]||(d.segs[i]=tokenize(l)); else segs=[['',l]];
    const fi=foldAt.get(i), r=fi!==undefined?d.regions[fi]:null;
    const cls=((r&&r.kind==='section')?'sec ':'')+(line===i+1?'flash':'');
    h+='<tr id="L'+(i+1)+'"'+(r?' data-r="'+fi+'"':'')+(cls.trim()?' class="'+cls.trim()+'"':'')+'><td class="f'+(r?' t':'')+'">'+(r?'▾':'')+'</td><td class="l">'+(i+1)+'</td><td class="c">'+emit(segs,ranges)+(r?'<span class="fd">… '+(r.e-r.hideFrom+1)+' lignes</span>':'')+'</td></tr>';
  }
  $('#body').innerHTML=h+'</table>';
  d.rows=[];
  $('#body').querySelectorAll('table.code tr').forEach(tr=>{
    if(tr.id) d.rows[+tr.id.slice(1)-1]=tr;
    else if(tr.dataset.r!==undefined){ const r=d.regions[+tr.dataset.r]; r.tr=tr; r.caret=tr.firstChild; }
  });
  d.regions.forEach(r=>{ if(r.kind!=='group'){ r.tr=d.rows[r.s]; r.caret=r.tr&&r.tr.firstChild; } });
  applyFolds();
  $('#fc').textContent=term?cnt+' occ.':'';
  const tgt=line?document.getElementById('L'+line):(first?document.getElementById('L'+first):null);
  if(tgt) tgt.scrollIntoView({block:'center'});
}
function applyFolds(){
  const d=doc; if(!d||!d.regions.length) return;
  const n=d.lines.length, diff=new Int32Array(n+2);
  d.collapsed.forEach(i=>{ const r=d.regions[i]; diff[r.hideFrom]++; diff[r.e+1]--; });
  let acc=0;
  for(let i=0;i<n;i++){ acc+=diff[i]; const tr=d.rows[i]; if(tr) tr.hidden=acc>0; }
  d.regions.forEach((r,idx)=>{
    if(!r.tr) return;
    const col=d.collapsed.has(idx);
    r.tr.classList.toggle('col',col);
    if(r.caret) r.caret.textContent=col?'▸':'▾';
    if(r.kind==='group'){
      let a=r.parent, hid=false;
      while(a){ if(d.collapsed.has(a.idx)){ hid=true; break; } a=a.parent; }
      r.tr.hidden=hid;
    }
  });
}
function toggleRegion(idx){
  if(!doc) return;
  if(doc.collapsed.has(idx)) doc.collapsed.delete(idx); else doc.collapsed.add(idx);
  applyFolds();
}

/* =====================================================================
   Recherche plein texte : regroupement par fichier, compteurs, CSV
   ===================================================================== */
async function search(){
  const q=$('#q').value.trim(); if(!q) return;
  const b=$('#body'); $('#vh').hidden=true; cur.file=null; doc=null; showingResults=false;
  let re, hre;
  try{
    const rx=$('#rx').checked, fl=$('#cs').checked?'':'i', src=rx?q:reEsc(q);
    re=new RegExp(src,fl); hre=new RegExp(src,'g'+fl);
  }catch(e){ b.innerHTML='<div class="err">Regex invalide : '+esc(e.message)+'</div>'; return; }
  const scope=$('#sc').checked?cur.dir:'';
  const list=files.filter(f=>!scope||f.path.startsWith(scope+'/'));
  const namesOnly=$('#nm').checked, results=[];
  let i=0, scanned=0, skipped=0, total=0; stopFlag=false;
  setBusy(true); const t0=performance.now();
  async function worker(){
    while(!stopFlag&&total<MAX_HITS){
      const f=list[i++]; if(!f) break;
      const fr={file:f.path,hits:[],lines:new Map(),name:re.test(base(f.path))};
      if(!namesOnly){
        try{
          const ls=(await readText(f)).split(/\r?\n/); scanned++;
          for(let n=0;n<ls.length&&total<MAX_HITS;n++)
            if(re.test(ls[n])){ fr.hits.push(n+1); fr.lines.set(n+1,ls[n].trim().slice(0,300)); total++; }
        }catch{ skipped++; }
      }
      if(fr.hits.length||fr.name) results.push(fr);
      if(i%10===0) b.innerHTML='<div class="note">Recherche… '+i+' / '+list.length+' fichiers · '+total+' résultat(s)</div>';
    }
  }
  await Promise.all(Array.from({length:8},worker));
  setBusy(false);
  results.sort((a,c)=>a.file.localeCompare(c.file,'fr',{numeric:true}));
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
  if((el=t.closest('td.f.t'))||(el=t.closest('tr.grp'))){ toggleRegion(+el.closest('tr').dataset.r); return; }
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
$('#go').onclick=search; $('#stop').onclick=()=>{stopFlag=true};
$('#q').onkeydown=e=>{if(e.key==='Enter')search()};

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
$('#q').oninput=()=>{ if(!$('#q').value&&showingResults) empty(); };

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
