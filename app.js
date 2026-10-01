const $=s=>document.querySelector(s);
const esc=s=>s.replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const reEsc=s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const fmt=n=>n<1024?n+' o':n<1048576?(n/1024).toFixed(1)+' Ko':(n/1048576).toFixed(1)+' Mo';
const dt=t=>new Date(t).toLocaleString('fr-FR',{dateStyle:'short',timeStyle:'short'});
const parent=p=>p.includes('/')?p.slice(0,p.lastIndexOf('/')):'';
const MAX_FILE=8*1024*1024, MAX_HITS=2000, HAS_FSA=!!window.showDirectoryPicker;

let files=[], tree=new Map(), rootName='', cur={dir:'',file:null}, curText='', curMeta=null, stopFlag=false, showingResults=false;

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
  cur={dir:'',file:null};
  $('#info').textContent=name+' — '+files.length+' fichiers';
  $('#q').disabled=false; $('#go').disabled=false;
  renderList(); empty();
}
function empty(){ showingResults=false; $('#vh').hidden=true; $('#body').innerHTML='<div class="empty">Sélectionne un fichier ou lance une recherche.</div>'; }

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

/* ---------- liste ---------- */
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
    const n=f.path.slice(f.path.lastIndexOf('/')+1);
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

/* ---------- lecture / affichage ---------- */
async function readText(f){
  const file=await f.get();
  if(file.size>MAX_FILE) throw new Error('fichier trop volumineux ('+Math.round(file.size/1048576)+' Mo)');
  const buf=new Uint8Array(await file.arrayBuffer());
  if(buf.subarray(0,4096).includes(0)) throw new Error('fichier binaire');
  try{ return new TextDecoder('utf-8',{fatal:true}).decode(buf); }
  catch{ return new TextDecoder('windows-1252').decode(buf); }
}
async function openFile(path,line){
  const f=files.find(x=>x.path===path); if(!f) return;
  try{
    if(cur.file!==path||!curText){ curText=await readText(f); }
    showingResults=false; cur.file=path; cur.dir=parent(path); curMeta=f; renderList();
    const vh=$('#vh'); vh.hidden=false;
    vh.innerHTML='<span class="t">'+esc(path)+'</span><span class="m">'+fmt(f.size)+' · '+dt(f.mtime)+' · '+curText.split('\n').length+' lignes</span>'+
      '<span class="fld" style="margin-left:auto"><input type="text" id="ff" placeholder="Chercher dans le fichier…" style="width:220px"><button class="x" type="button" title="Effacer" hidden>×</button></span><span class="m" id="fc"></span>'+
      '<button class="sec" id="cp">Copier</button><button class="sec" id="dl">Télécharger</button>';
    $('#ff').oninput=()=>draw(0);
    $('#cp').onclick=()=>navigator.clipboard.writeText(curText).then(()=>{$('#cp').textContent='Copié ✓';setTimeout(()=>$('#cp').textContent='Copier',1200)});
    $('#dl').onclick=async()=>{const fl=await f.get();const a=document.createElement('a');a.href=URL.createObjectURL(fl);a.download=path.split('/').pop();a.click();setTimeout(()=>URL.revokeObjectURL(a.href),5000)};
    draw(line);
  }catch(e){ curText=''; cur.file=null; $('#vh').hidden=true; $('#body').innerHTML='<div class="err">'+esc(path)+' : '+esc(e.message)+'</div>'; }
}
function draw(line){
  const term=($('#ff')||{}).value||''; const lines=curText.split('\n'); let re=null,cnt=0;
  if(term) re=new RegExp('('+reEsc(esc(term))+')','gi');
  let h='<table class="code">';
  lines.forEach((t,i)=>{
    let e=esc(t); if(re) e=e.replace(re,m=>{cnt++;return '<mark>'+m+'</mark>'});
    h+='<tr id="L'+(i+1)+'"'+(line===i+1?' class="flash"':'')+'><td class="l">'+(i+1)+'</td><td class="c">'+e+'</td></tr>';
  });
  $('#body').innerHTML=h+'</table>';
  $('#fc').textContent=term?cnt+' occ.':'';
  const tgt=line?document.getElementById('L'+line):(term?document.querySelector('mark'):null);
  if(tgt) tgt.scrollIntoView({block:'center'});
}

/* ---------- recherche plein texte ---------- */
async function search(){
  const q=$('#q').value.trim(); if(!q) return;
  const b=$('#body'); $('#vh').hidden=true; cur.file=null; curText='';
  let re, hre;
  try{
    const src=$('#rx').checked?q:reEsc(q), fl=$('#cs').checked?'':'i';
    re=new RegExp(src,fl); hre=new RegExp('('+($('#rx').checked?q:reEsc(esc(q)))+')','g'+fl);
  }catch(e){ b.innerHTML='<div class="err">Regex invalide : '+esc(e.message)+'</div>'; return; }
  const scope=$('#sc').checked?cur.dir:'';
  const list=files.filter(f=>!scope||f.path.startsWith(scope+'/'));
  const namesOnly=$('#nm').checked, hits=[]; let i=0,scanned=0,skipped=0; stopFlag=false;
  $('#go').hidden=true; $('#stop').hidden=false; const t0=performance.now();
  async function worker(){
    while(!stopFlag&&hits.length<MAX_HITS){
      const f=list[i++]; if(!f) break;
      if(re.test(f.path.slice(f.path.lastIndexOf('/')+1))) hits.push({file:f.path,line:0,text:'(nom de fichier)'});
      if(namesOnly) continue;
      try{
        const txt=await readText(f); scanned++;
        const ls=txt.split('\n');
        for(let n=0;n<ls.length;n++) if(re.test(ls[n])){ hits.push({file:f.path,line:n+1,text:ls[n].trim().slice(0,300)}); if(hits.length>=MAX_HITS) break; }
      }catch{ skipped++; }
      if(i%10===0) b.innerHTML='<div class="note">Recherche… '+i+' / '+list.length+' fichiers · '+hits.length+' résultat(s)</div>';
    }
  }
  await Promise.all(Array.from({length:8},worker));
  $('#go').hidden=false; $('#stop').hidden=true;
  hits.sort((a,b)=>a.file.localeCompare(b.file,'fr')||a.line-b.line);
  let h='<div class="note">'+hits.length+' résultat(s) · '+scanned+' fichiers lus'+(skipped?' · '+skipped+' ignorés (binaires/trop gros)':'')+' · '+((performance.now()-t0)/1000).toFixed(1)+' s'+(stopFlag?' · <b>interrompu</b>':'')+(hits.length>=MAX_HITS?' · <b>tronqué</b>':'')+'</div>';
  let last=null;
  hits.forEach(x=>{
    if(x.file!==last){ last=x.file; h+='<div class="res-f" data-f="'+esc(x.file)+'" data-l="0">'+esc(x.file)+'</div>'; }
    if(x.line){
      let t=esc(x.text); if(!$('#rx').checked) t=t.replace(hre,'<mark>$1</mark>');
      h+='<div class="res-h" data-f="'+esc(x.file)+'" data-l="'+x.line+'"><span class="ln">'+x.line+'</span><span class="tx">'+t+'</span></div>';
    }
  });
  showingResults=true; b.innerHTML=h;
  b.querySelectorAll('[data-f]').forEach(el=>el.onclick=()=>openFile(el.dataset.f,+el.dataset.l));
}
$('#go').onclick=search; $('#stop').onclick=()=>{stopFlag=true};
$('#q').onkeydown=e=>{if(e.key==='Enter')search()};

/* ---------- croix d'effacement (délégation) + Échap ---------- */
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

/* ---------- colonne de gauche redimensionnable ---------- */
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
