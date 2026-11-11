/* Web dashboard only: host SDK registration, no Desktop/native bridge or tokens. */
(function(root){
'use strict';
function createController(request){
  const state={data:null,selected:[],query:'',draft:{targets:['delegation'],route:'explicit',provider:'fixture',model:'model-b',effort:null},preview:null,confirmed:false,result:null,error:'',busy:false};
  const listeners=new Set();
  let sentDraft=null, generation=0;
  function emit(){listeners.forEach(fn=>fn());}
  function edit(fn){if(state.busy)return;fn();state.preview=null;state.confirmed=false;sentDraft=null;state.error='';state.result=null;emit();}
  const c={state,subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);},
    async load(){const g=++generation;state.busy=true;state.error='';state.preview=null;state.confirmed=false;emit();try{const data=await request('/state');if(g===generation){state.data=data;state.selected=state.selected.filter(p=>(data.profiles||[]).some(r=>r.profile===p));}}catch(e){if(g===generation){state.data=null;state.selected=[];state.error='Read unavailable';}}finally{if(g===generation){state.busy=false;emit();}}},
    filter(q){state.query=q;emit();},
    visible(){const terms=state.query.toLowerCase().split(/[,\s]+/).filter(Boolean);return (state.data?.profiles||[]).filter(p=>!terms.length||terms.some(t=>p.profile.toLowerCase().includes(t)));},
    toggle(p){edit(()=>{if(!(state.data?.fixture===true||state.data?.available===true)||!(state.data?.profiles||[]).some(r=>r.profile===p))return;state.selected=state.selected.includes(p)?state.selected.filter(v=>v!==p):state.selected.concat([p]);});},
    setDraft(patch){edit(()=>{Object.assign(state.draft,patch);if(state.draft.route!=='explicit'){state.draft.provider='';state.draft.model='';}});},
    problem(){const d=state.draft;if(!state.selected.length)return 'Select at least one profile';if(!d.targets.length)return 'Choose at least one target';if(d.targets.includes('main')&&['inherit','auto'].includes(d.route))return 'Main cannot inherit or use auto';if(d.targets.includes('delegation')&&d.route==='auto')return 'Delegation has no auto mode';if(d.route==='explicit'&&(!d.provider||!d.model))return 'Choose a provider and model';if(d.route==='keep'&&d.effort===null)return 'Choose a route or effort change';return '';},
    confirm(on){if(!state.busy){state.confirmed=on===true;emit();}},
    async preview(){if(state.busy||!state.selected.length)return;const g=++generation;state.busy=true;state.error='';state.result=null;state.preview=null;state.confirmed=false;emit();
      const revs={};state.selected.forEach(p=>{revs[p]=state.data.profiles.find(r=>r.profile===p).revision;});
      sentDraft=JSON.parse(JSON.stringify(Object.assign({},state.draft,{profiles:state.selected.slice(),expected_revisions:revs})));
      try{const preview=await request('/preview',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(sentDraft)});if(g===generation)state.preview=preview;}catch(e){if(g===generation){state.error=String(e.message||'Preview failed');sentDraft=null;}}finally{if(g===generation){state.busy=false;emit();}}},
    async apply(){if(state.busy||!state.preview||!state.confirmed)return;state.busy=true;state.error='';emit();
      const token=state.preview.token;state.preview=null;state.confirmed=false;
      try{state.result=await request('/apply',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({draft:sentDraft,token,confirmed:true})});state.data=await request('/state');}catch(e){state.error=String(e.message||'Save outcome uncertain; reload, never replay');}finally{state.busy=false;sentDraft=null;emit();}}
  };
  return c;
}
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const CSS=`
.hermes-model-board{--bg:#0d0e12;--panel:#15161c;--panel2:#1b1c24;--line:#272834;--text:#e7e7ee;--dim:#9a9bab;--accent:#9d7bff;--ok:#4ade80;--warn:#f5b942;--bad:#f87171;background:var(--bg);color:var(--text);font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;min-height:100vh;color-scheme:dark}
.hermes-model-board *{box-sizing:border-box}
.hermes-model-board header.top{position:sticky;top:0;z-index:5;background:var(--bg);border-bottom:1px solid var(--line);padding:12px 16px;display:flex;align-items:center;gap:12px}
.hermes-model-board h1{font-size:15px;letter-spacing:.04em;color:var(--accent);margin:0}.hermes-model-board h2{font-size:15px;margin:0 0 10px}.hermes-model-board h3{font-size:14px;margin:0 0 6px}
.hermes-model-board main{max-width:1240px;margin:auto;padding:12px 12px calc(60px + env(safe-area-inset-bottom))}
.hermes-model-board button,.hermes-model-board select,.hermes-model-board input[type=search]{font:inherit;color:var(--text);background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:10px 12px;min-height:44px;max-width:100%}
.hermes-model-board button{cursor:pointer}.hermes-model-board button:hover{border-color:var(--accent)}.hermes-model-board button:disabled{opacity:.45;cursor:default}.hermes-model-board button.primary{background:var(--accent);border-color:var(--accent);color:#111;font-weight:600}
.hermes-model-board :focus-visible{outline:2px solid var(--accent);outline-offset:3px}.hermes-model-board input[type=checkbox]{width:18px;height:18px;accent-color:var(--accent);flex:none}
.hermes-model-board .sp{flex:1}.hermes-model-board .dim{color:var(--dim)}.hermes-model-board .mono{font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere}.hermes-model-board .warn{color:var(--warn)}.hermes-model-board .good{color:var(--ok)}
.hermes-model-board .notice{padding:14px;border:1px solid var(--warn);background:#201c16;border-radius:8px;margin:0 0 12px;overflow-wrap:anywhere}.hermes-model-board .notice strong{display:block;margin-bottom:4px}
.hermes-model-board details.sec{background:var(--panel);border:1px solid var(--line);border-radius:8px;margin:12px 0;overflow:hidden}.hermes-model-board details.sec>summary{cursor:pointer;padding:14px;font-weight:600}.hermes-model-board details.sec>summary::marker{color:var(--accent)}
.hermes-model-board .secbody{border-top:1px solid var(--line)}.hermes-model-board .pad{padding:14px}.hermes-model-board .count{color:var(--dim);font-weight:400;font-size:12px;margin-left:6px}
.hermes-model-board .stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:1px;background:var(--line)}.hermes-model-board .stat{background:var(--panel);padding:12px 14px;min-width:0}.hermes-model-board .stat b{display:block;font-size:22px}.hermes-model-board .stat span{font-size:12px;color:var(--dim)}
.hermes-model-board .toolbar{display:flex;gap:10px;flex-wrap:wrap;align-items:center}.hermes-model-board .psearch{padding:12px 14px;border-bottom:1px solid var(--line)}.hermes-model-board .psearch input{width:100%;margin-top:6px}
.hermes-model-board .prow{display:grid;grid-template-columns:minmax(140px,1fr) repeat(3,minmax(0,1fr));gap:18px;padding:14px;border-top:1px solid var(--line);align-items:start}.hermes-model-board .prow:first-child{border:0}.hermes-model-board .prow.selected{background:var(--panel2)}.hermes-model-board .profile-name{font-weight:600}.hermes-model-board .route-label{display:block;color:var(--dim);font-size:11px;text-transform:uppercase;letter-spacing:.04em;margin-bottom:4px}
.hermes-model-board label.check{display:flex;gap:9px;align-items:center;min-height:44px;cursor:pointer}.hermes-model-board .target-list{display:flex;flex-wrap:wrap;gap:8px 22px}.hermes-model-board fieldset{min-width:0;border:1px solid var(--line);border-radius:6px;margin:0 0 16px;padding:8px 12px}.hermes-model-board legend{color:var(--dim);font-size:12px;padding:0 6px}
.hermes-model-board .fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.hermes-model-board .field{display:block;min-width:0}.hermes-model-board .field>span{display:block;margin-bottom:6px;color:var(--dim);font-size:12px}.hermes-model-board select{width:100%}.hermes-model-board .foot{color:var(--dim);font-size:12px;margin:14px 0;overflow-wrap:anywhere}.hermes-model-board .error{color:var(--bad);overflow-wrap:anywhere}.hermes-model-board .error:empty{display:none}
.hermes-model-board .preview-box{background:var(--panel);border:1px solid var(--line);border-radius:8px;margin:14px 0}.hermes-model-board .preview-profile{padding:14px 0;border-bottom:1px solid var(--line)}.hermes-model-board .change{padding:8px 0}.hermes-model-board .change b{color:var(--accent)}.hermes-model-board .values{display:grid;grid-template-columns:minmax(0,1fr) 20px minmax(0,1fr);gap:8px;margin-top:4px}.hermes-model-board .old{color:#b5b6c4;text-decoration:line-through}.hermes-model-board .confirmation{padding:14px 0}
@media(max-width:700px){.hermes-model-board main{padding:10px 8px 60px}.hermes-model-board .stats{grid-template-columns:repeat(2,minmax(0,1fr))}.hermes-model-board .prow{grid-template-columns:minmax(0,1fr);gap:12px}.hermes-model-board .route-cell{display:grid;grid-template-columns:90px minmax(0,1fr);align-items:start}.hermes-model-board .route-label{padding-top:2px}.hermes-model-board .fields{grid-template-columns:1fr}.hermes-model-board .target-list{display:block}.hermes-model-board .toolbar button{flex:1}.hermes-model-board header.top{padding:10px 14px}}
`;
function mount(container,c,options={}){
  container.innerHTML=`<div class="hermes-model-board"><style>${CSS}</style>
    <header class="top"><h1>MODEL BOARD <span class="dim">beta</span></h1><span class="sp"></span><button id="reload">Reload</button></header>
    <main><div id="candidate-status" class="notice" role="status">Connecting to backend…</div>
    <details class="sec" open><summary>Overview</summary><div class="secbody"><div id="stats" class="stats"></div><p id="provenance" class="pad foot"></p></div></details>
    <details class="sec" open><summary>Profiles <span id="profile-count" class="count"></span></summary><div class="secbody"><div class="psearch"><label for="profile-filter">Filter profiles by name</label><input id="profile-filter" type="search" placeholder="alpha, beta" autocomplete="off" spellcheck="false"><div class="toolbar"><span id="selected-count" class="foot"></span></div></div><div id="profile-list"></div></div></details>
    <details class="sec" id="draft-section" open><summary>Change several <span class="count">Draft → preview → confirm → Apply</span></summary><div class="secbody pad">
    <p class="dim">Changes target every ticked profile, including profiles hidden by the filter.</p>
    <fieldset id="draft-controls"><legend>What to change</legend><div class="target-list">
    <label class="check"><input type="checkbox" id="target-main" value="main">Main model</label><label class="check"><input type="checkbox" id="target-delegation" value="delegation">Delegation / subagents</label><label class="check"><input type="checkbox" id="target-aux" value="auxiliary.vision">Auxiliary · vision</label></div>
    <div class="fields"><label class="field"><span>Route</span><select id="route"><option value="explicit">Specific provider / model</option><option value="keep">Keep current route · effort only</option><option value="inherit">Inherit main · delegation / auxiliary only</option><option value="auto">Auto · auxiliary only</option></select></label>
    <label class="field"><span>Reasoning effort · all chosen targets</span><select id="effort"><option value="keep">Keep current effort</option><option value="">Clear stored effort</option>${['minimal','low','medium','high','xhigh'].map(v=>`<option value="${v}">${v}</option>`).join('')}</select></label>
    <label class="field"><span>Provider · selected profiles’ catalog</span><select id="provider"></select></label><label class="field"><span>Model · selected profiles’ catalog</span><select id="model"></select></label></div></fieldset>
    <p id="draft-problem" class="dim"></p><button id="preview-button" class="primary">Preview exact changes</button>
    <p class="foot">First slice: main, delegation and vision. No login setup, jobs, federation or gateway controls.</p></div></details>
    <p id="candidate-error" class="error" role="alert"></p>${options.simulateChange?'<div class="pad"><button id="simulate-stale">Simulate another edit to beta</button><p id="fixture-note" role="status"></p></div>':''}<div id="preview-panel"></div><div id="result-panel" aria-live="polite"></div>
    <p class="foot">Apply persists profile defaults; it does not switch running sessions, install other services or start gateways.</p></main></div>`;
  const $=s=>container.querySelector(s), s=c.state;
  function routeText(r,effort){if(!r)return 'unavailable';const inherited=!r.provider||r.provider==='main';return (r.provider==='auto'?'auto':inherited?'inherits main':`${r.model||r.default||'—'} (${r.provider})`)+` · effort: ${effort===false?'none':effort||'not set'}`;}
  function render(){
    const fixture=s.data?.fixture===true,editable=fixture||s.data?.available===true;
    $('#candidate-status').innerHTML=fixture?'<strong>SYNTHETIC FIXTURE — not live</strong>Two fake profiles, local synthetic files only. This harness cannot reach live profiles.':s.data?.available===true?'<strong>Native mode · authenticated local host</strong>Host-owned catalog and local config backend. Explicit preview and confirmation required.':`<strong>Native mode · read-only / unavailable</strong>${esc(s.data?.reason||'Waiting for backend status. No live writes enabled.')}`;
    $('#provenance').textContent=s.data?.inventory_provenance||s.data?.reason||'Inventory unavailable';
    $('#stats').innerHTML=[[s.data?.profiles?.length||0,fixture?'synthetic profiles':'host profiles'],[s.selected.length,'ticked profiles'],[s.data?.available===true?'1':'0','native adapters'],['1','host / no federation']].map(([n,label])=>`<div class="stat"><b>${esc(n)}</b><span>${label}</span></div>`).join('');
    $('#profile-count').textContent=`${c.visible().length} shown`;
    $('#selected-count').textContent=`${s.selected.length} ticked${s.selected.length?' · '+s.selected.join(', '):''}`;
    $('#profile-list').innerHTML=c.visible().map(p=>`<article class="prow ${s.selected.includes(p.profile)?'selected':''}" data-profile="${esc(p.profile)}"><label class="check profile-name"><input id="select-${esc(p.profile)}" type="checkbox" data-select="${esc(p.profile)}" ${s.selected.includes(p.profile)?'checked':''} ${!editable||s.busy?'disabled':''}>${esc(p.profile)}</label>${[['Main',p.routes?.model,p.routes?.agent?.reasoning_effort],['Delegation',p.routes?.delegation,p.routes?.delegation?.reasoning_effort],['Aux · vision',p.routes?.auxiliary?.vision,p.routes?.auxiliary?.vision?.reasoning_effort]].map(([label,route,effort])=>`<div class="route-cell"><span class="route-label">${label}</span><span class="mono">${esc(routeText(route,effort))}</span></div>`).join('')}</article>`).join('')||'<p class="pad dim">No matching profiles.</p>';
    const d=s.draft;
    for(const el of container.querySelectorAll('[id^="target-"]'))el.checked=d.targets.includes(el.value);
    $('#route').value=d.route;$('#effort').value=d.effort===null?'keep':d.effort;
    const chosen=(s.data?.profiles||[]).filter(p=>s.selected.includes(p.profile)),all=chosen.length?chosen:(s.data?.profiles||[]),models=(all[0]?.models||[]).filter(m=>all.every(p=>(p.models||[]).some(n=>n.provider===m.provider&&n.model===m.model))),providers=[...new Set(models.map(m=>m.provider))];
    $('#provider').innerHTML='<option value="">Choose provider</option>'+providers.map(p=>`<option value="${esc(p)}">${esc(p)}</option>`).join('');$('#provider').value=d.provider;
    $('#model').innerHTML='<option value="">Choose model</option>'+models.filter(m=>m.provider===d.provider).map(m=>`<option value="${esc(m.model)}">${esc(m.model)}</option>`).join('');$('#model').value=d.model;
    $('#draft-controls').disabled=s.busy||!editable;$('#provider').disabled=$('#model').disabled=d.route!=='explicit';
    $('#preview-button').disabled=s.busy||!editable||!!c.problem();$('#reload').disabled=s.busy;
    $('#draft-problem').textContent=editable?c.problem():'Native changes disabled: no live write adapter.';
    $('#candidate-error').textContent=s.error;
    const preview=$('#preview-panel');
    if(!s.preview){preview.innerHTML='';delete preview.dataset.token;}
    else if(preview.dataset.token!==s.preview.token){
      preview.dataset.token=s.preview.token;
      const value=v=>v.present?JSON.stringify(v.value):'(not present)';
      preview.innerHTML=`<section class="sec preview-box pad" aria-labelledby="preview-heading"><h2 id="preview-heading">Exact preview · ${fixture?'synthetic files only':'selected host profiles'}</h2><p class="warn">${esc(s.preview.warning||'Preview only; nothing saved yet.')}</p>${s.preview.profiles.map(p=>`<article class="preview-profile" data-preview-profile="${esc(p.profile)}"><h3>${esc(p.profile)}</h3>${p.changes.length?p.changes.map(change=>`<div class="change"><b class="mono">${esc(change.field)}</b><div class="values"><span class="old mono">${esc(value(change.before))}</span><span aria-hidden="true">→</span><span class="good mono">${esc(value(change.after))}</span></div></div>`).join(''):'<p class="dim">No field changes · unchanged</p>'}</article>`).join('')}<label class="check confirmation"><input id="confirmation" type="checkbox">I reviewed these exact changes for every ticked ${fixture?'synthetic':'host'} profile.</label><button id="apply-button" class="primary">Apply to ${fixture?'synthetic files':'selected profiles'}</button></section>`;
      $('#confirmation').onchange=e=>c.confirm(e.target.checked);$('#apply-button').onclick=()=>c.apply();
    }
    if($('#confirmation')){$('#confirmation').checked=s.confirmed;$('#confirmation').disabled=s.busy;$('#apply-button').disabled=s.busy||!s.confirmed;}
    $('#result-panel').innerHTML=s.result?`<section class="sec preview-box pad"><h2>${s.result.partial?'Partial outcome · inspect each profile':s.result.ok?(fixture?'Saved · synthetic files only':'Saved · exact host readback'):'Save failed · inspect each profile'}</h2>${s.result.profiles.map(p=>`<article class="preview-profile" data-result-profile="${esc(p.profile)}"><h3>${esc(p.profile)} <span class="${['applied','unchanged'].includes(p.state)?'good':'error'}">${esc(p.state)}</span></h3>${p.detail?`<p class="error">${esc(p.detail)}</p>`:`<p class="dim">Exact saved-config readback verified by ${fixture?'fixture':'host'} backend.</p>`}</article>`).join('')}<p class="foot">Sequential profile saves, not a multi-profile transaction. No automatic retries.</p></section>`:'';
  }
  $('#profile-filter').oninput=e=>c.filter(e.target.value);
  $('#profile-list').onchange=e=>{if(e.target.dataset.select)c.toggle(e.target.dataset.select);};
  for(const el of container.querySelectorAll('[id^="target-"]'))el.onchange=()=>c.setDraft({targets:['target-main','target-delegation','target-aux'].map(id=>$('#'+id)).filter(el=>el.checked).map(el=>el.value)});
  $('#route').onchange=e=>c.setDraft({route:e.target.value});
  $('#provider').onchange=e=>c.setDraft({provider:e.target.value,model:''});$('#model').onchange=e=>c.setDraft({model:e.target.value});
  $('#effort').onchange=e=>c.setDraft({effort:e.target.value==='keep'?null:e.target.value});
  $('#reload').onclick=()=>c.load();$('#preview-button').onclick=()=>c.preview();
  if($('#simulate-stale'))$('#simulate-stale').onclick=async()=>{const b=$('#simulate-stale');b.disabled=true;try{await options.simulateChange();$('#fixture-note').textContent='beta changed outside this preview';}catch(e){$('#fixture-note').textContent='Simulation failed';}finally{b.disabled=false;}};
  const unsubscribe=c.subscribe(render);render();c.load();
  return ()=>{unsubscribe();container.innerHTML='';};
}
root.ModelBoardCandidate={createController,mount};
const sdk=root.__HERMES_PLUGIN_SDK__,plugins=root.__HERMES_PLUGINS__;
if(sdk?.React&&typeof sdk.fetchJSON==='function'&&typeof plugins?.register==='function'){
  const React=sdk.React;
  plugins.register('hermes-model-board',function ModelBoardCandidatePage(){
    const ref=React.useRef(null);
    const controller=React.useMemo(()=>createController((path,init)=>sdk.fetchJSON('/api/plugins/hermes-model-board'+path,init)),[]);
    React.useEffect(()=>mount(ref.current,controller),[controller]);
    return React.createElement('div',{ref});
  });
}
})(window);
