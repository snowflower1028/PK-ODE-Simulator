/*───────────────────────────────*
 *  dosing.js  (PK Simulator UI) *
 *───────────────────────────────*/

const doseList     = [];
let   observedData = null;
let   fitTimer     = null;        // 진행 타이머

/* ───────────────── DOM 준비 ───────────────── */
document.addEventListener("DOMContentLoaded", () => {

  /* IV infusion duration 토글 */
  document.getElementById("type").addEventListener("change", e => {
    document.getElementById("duration-label").style.display =
      e.target.value === "infusion" ? "block" : "none";
  });

  /* 시뮬 compartment 선택 배지 업데이트 */
  document.addEventListener("change", e=>{
    if(e.target.classList.contains("sim-comp-checkbox")) updateSelectedBadges();
  });
  document.getElementById("selected-comp-badges").addEventListener("click", e=>{
    if(e.target.classList.contains("badge")){
      const c = e.target.textContent;
      document.querySelector(`.sim-comp-checkbox[value="${c}"]`).checked = false;
      updateSelectedBadges();
    }
  });

  /* CSV 관측 파일 업로드 */
  document.getElementById("obs-upload").addEventListener("change", e=>{
    const f = e.target.files[0]; if(!f) return;
    const reader = new FileReader();
    reader.onload = ev=>{
      const lines  = ev.target.result.split(/\r?\n/).filter(Boolean);
      const head   = lines[0].split(",");
      const tIdx   = head.findIndex(h=>h.trim().toLowerCase()==="time");
      if(tIdx===-1) return alert("CSV needs a 'Time' column.");
      const obs={}, time=[];
      head.forEach((h,i)=>{ if(i!==tIdx) obs[h.trim()]=[]; });
      for(let i=1;i<lines.length;i++){
        const vals = lines[i].split(",");
        if(vals.length<=tIdx) continue;
        time.push(parseFloat(vals[tIdx]));
        head.forEach((h,idx)=>{
          if(idx===tIdx) return;
          const v=parseFloat(vals[idx]);
          obs[h.trim()].push(Number.isNaN(v)?null:v);
        });
      }
      observedData={Time:time,...obs};
      alert("✅ Observed data loaded!");
    };
    reader.readAsText(f);
  });

  /* Dosing form submit */
  document.getElementById("dose-form").addEventListener("submit", e=>{
    e.preventDefault();
    const d = {
      compartment : document.getElementById("compartment").value,
      type        : document.getElementById("type").value,
      amount      : +document.getElementById("amount").value,
      start_time  : +document.getElementById("start_time").value,
      duration    : +document.getElementById("duration").value || 0,
      repeat_every: +document.getElementById("repeat_every").value,
      repeat_until: +document.getElementById("repeat_until").value
    };
    if(Number.isNaN(d.repeat_every)) d.repeat_every=null;
    if(Number.isNaN(d.repeat_until)) d.repeat_until=null;
    doseList.push(d); renderDoses(); e.target.reset();
    document.getElementById("duration-label").style.display="none";
  });

});

/*─────────────────────────────────────────────*
 * 1. ODE Parsing
 *─────────────────────────────────────────────*/
function parseODE(){
  fetch("/parse/",{
    method:"POST",
    headers:{"Content-Type":"application/json","X-CSRFToken":getCSRFToken()},
    body:JSON.stringify({text:document.getElementById("ode-input").value})
  })
  .then(r=>r.json())
  .then(dat=>{
    if(dat.status!=="ok") return alert("Parse failed");
    const {compartments,parameters,processed_ode,derived_expressions}=dat.data;
    window._compartments=compartments;
    window._parameters  =parameters;
    window._processedODE=processed_ode;
    window._derivedExpressions=derived_expressions;
    renderSymbolInputs(compartments,parameters,derived_expressions);
  });
}

/*─────────────────────────────────────────────*
 * 2. Value-input renderer
 *─────────────────────────────────────────────*/
function renderSymbolInputs(comps,pars,derived){
  const initDiv=document.getElementById("init-values");
  const paramDiv=document.getElementById("param-values");
  initDiv.innerHTML=paramDiv.innerHTML="";

  /* Initials */
  comps.forEach(c=>{
    initDiv.insertAdjacentHTML("beforeend",`
      <div class="d-flex align-items-center mb-2">
        <label for="init_${c}" class="mb-0 me-2 text-end" style="width:70px;">${c}:</label>
        <input type="number" step="any" value="0" id="init_${c}" name="init_${c}"
               class="form-control form-control-sm flex-grow-1">
      </div>`);
  });

  /* Parameter rows + Fit checkbox */
  pars.forEach(p=>{
    paramDiv.insertAdjacentHTML("beforeend",`
      <div class="d-flex align-items-center mb-2">
        <label for="param_${p}" class="mb-0 me-2 text-end" style="width:70px;">${p}:</label>
        <input type="number" step="any" id="param_${p}" name="param_${p}"
               class="form-control form-control-sm flex-grow-1">
        <div class="form-check ms-2" style="width:24px;">
          <input type="checkbox" class="form-check-input fit-checkbox" data-param="${p}"
                 title="include in fitting">
        </div>
      </div>`);
  });

  /* Derived-param display */
  Object.entries(derived)
    .filter(([k])=>!pars.includes(k))
    .forEach(([k,expr])=>{
      paramDiv.insertAdjacentHTML("beforeend",`
        <div class="derived-box"><i class="bi bi-calculator"></i>
        <strong>${k}</strong> = ${expr}</div>`);
    });

  /* Dose & sim compartment selectors */
  const cmpSel=document.getElementById("compartment");
  cmpSel.innerHTML=comps.map(c=>`<option>${c}</option>`).join("");
  const simMenu=document.getElementById("sim-compartments-menu");
  simMenu.innerHTML=comps.map(c=>`
      <li><label class="dropdown-item">
         <input type="checkbox" class="form-check-input me-2 sim-comp-checkbox" value="${c}" checked>
         ${c}</label></li>`).join("");
  updateSelectedBadges();
}

/*─────────────────────────────────────────────*
 * 3. Simulation
 *─────────────────────────────────────────────*/
let simRunning=false;
document.getElementById("simulate-btn").onclick = () => {
  if(simRunning) return;
  simRunning=true;

  const odeText=document.getElementById("ode-input").value.trim();
  const t0=+document.getElementById("sim-start-time").value;
  const t1=+document.getElementById("sim-end-time").value;
  const nSteps=+document.getElementById("sim-steps").value;
  const logScale=document.getElementById("log-scale").checked;
  const selComps=[...document.querySelectorAll(".sim-comp-checkbox:checked")].map(e=>e.value);

  const initials={}, params={};
  window._compartments.forEach(c=>{
    initials[c]=+document.querySelector(`input[name="init_${c}"]`).value;
  });
  window._parameters.forEach(p=>{
    params[p]=+document.querySelector(`input[name="param_${p}"]`).value;
  });

  fetch("/simulate/",{
    method:"POST",
    headers:{"Content-Type":"application/json","X-CSRFToken":getCSRFToken()},
    body:JSON.stringify({
      equations:odeText, compartments:selComps, parameters:params, initials:initials,
      doses:doseList, t_start:t0, t_end:t1, t_steps:nSteps, log_scale:logScale
    })
  })
  .then(r=>r.json())
  .then(d=>{
     if(d.status!=="ok") throw d.message;
     plotSimulationResult(d.data.profile,logScale,selComps);
     displayPKSummary(d.data.pk);
  })
  .catch(err=>alert("Simulation error: "+err))
  .finally(()=>{simRunning=false;});
};

/*─────────────────────────────────────────────*
 * 4. Non-linear Fitting
 *─────────────────────────────────────────────*/
document.getElementById("fit-btn").onclick = () => {
  if(!observedData) return alert("⚠️ Upload observed data first.");

  /* collect values with validation */
  const initials={}, params={};
  for(const c of window._compartments){
    const v=+document.querySelector(`input[name="init_${c}"]`).value;
    if(Number.isNaN(v)) return alert(`Init "${c}" empty.`); initials[c]=v;
  }
  for(const p of window._parameters){
    const v=+document.querySelector(`input[name="param_${p}"]`).value;
    if(Number.isNaN(v)) return alert(`Param "${p}" empty.`); params[p]=v;
  }

  const fitParams=[...document.querySelectorAll(".fit-checkbox:checked")]
                    .map(cb=>cb.dataset.param);
  if(!fitParams.length) return alert("Select parameters to fit.");

  const body={
    equations:document.getElementById("ode-input").value.trim(),
    compartments:window._compartments,
    initials, parameters:params, observed:observedData, fit_params:fitParams
  };

  /* modal refs */
  const modalEl=document.getElementById("fitModal");
  const modal  =new bootstrap.Modal(modalEl);
  const msg    =modalEl.querySelector("#fit-msg");
  const elapsed=modalEl.querySelector("#fit-elapsed");
  const bar    =modalEl.querySelector("#fit-progress");
  const resBox =modalEl.querySelector("#fit-result");

  msg.textContent="Running…"; resBox.innerHTML=""; bar.style.display="block";
  modal.show();

  /* timer */
  if(fitTimer) clearInterval(fitTimer);
  const t0=Date.now();
  fitTimer=setInterval(()=>elapsed.textContent=` (${Math.floor((Date.now()-t0)/1000)}s)`,1000);

  fetch("/fit/",{method:"POST",headers:{"Content-Type":"application/json","X-CSRFToken":getCSRFToken()},
                 body:JSON.stringify(body)})
  .then(r=>r.json())
  .then(res=>{
     if(res.status!=="ok") throw res.message;
     window.updateInputFields(res.data.params);
     window.renderFitSummary(res.data.params,res.data.cost);
     window.autoSimulate();

     const rows=Object.entries(res.data.params)
        .map(([k,v])=>`<tr><td>${k}</td><td>${v.toPrecision(6)}</td></tr>`).join("");
     resBox.innerHTML=`
       <table class="table table-sm mb-2">
        <thead><tr><th>Param</th><th>Value</th></tr></thead><tbody>${rows}</tbody></table>
       <p class="small text-muted mb-0">Cost (SSR): ${res.data.cost.toFixed(4)}</p>`;
     msg.textContent="Done 🎉";
  })
  .catch(err=>{
     msg.innerHTML=`<span class="text-danger">Error: ${err}</span>`;
  })
  .finally(()=>{
     clearInterval(fitTimer); fitTimer=null; bar.style.display="none";
  });
};

/*─────────────────────────────────────────────*
 * 5. Helper functions (global)
 *─────────────────────────────────────────────*/
function updateInputFields(dict){
  for(const [k,v] of Object.entries(dict)){
    const el=document.getElementById(`param_${k}`);
    if(el) el.value=v;
  }
}
window.updateInputFields=updateInputFields;

function renderFitSummary(dict,cost){
  const card=document.getElementById("fit-summary-card");
  const box=document.getElementById("fit-summary");
  const rows=Object.entries(dict)
      .map(([k,v])=>`<tr><td>${k}</td><td>${v.toPrecision(6)}</td></tr>`).join("");
  box.innerHTML=`
     <table class="table table-sm mb-2"><thead>
       <tr><th>Param</th><th>Value</th></tr></thead><tbody>${rows}</tbody></table>
     <p class="small text-muted mb-0">Cost (SSR): ${cost.toFixed(4)}</p>`;
  card.style.display="block";
}
window.renderFitSummary=renderFitSummary;

function autoSimulate(){ document.getElementById("simulate-btn").click(); }
window.autoSimulate=autoSimulate;

function updateSelectedBadges(){
  const con=document.getElementById("selected-comp-badges");
  con.innerHTML=[...document.querySelectorAll(".sim-comp-checkbox:checked")]
       .map(cb=>`<span class="badge bg-secondary me-1">${cb.value}</span>`).join("");
}

function renderDoses(){
  const con=document.getElementById("dose-list");
  if(!doseList.length){ con.innerHTML="<p class='text-muted'>No doses registered.</p>"; return;}
  con.innerHTML=`<table class="table table-sm table-bordered table-striped">
     <thead class="table-light"><tr>
       <th>#</th><th>Compartment</th><th>Type</th><th>Amount</th><th>Start</th>
       <th>Duration</th><th>Repeat every</th><th>Repeat until</th><th></th></tr></thead>
     <tbody>${
        doseList.map((d,i)=>`
          <tr>
            <td>${i+1}</td><td>${d.compartment}</td><td>${d.type}</td><td>${d.amount}</td>
            <td>${d.start_time}</td><td>${d.type==="infusion"?d.duration:"-"}</td>
            <td>${d.repeat_every||"-"}</td><td>${d.repeat_until||"-"}</td>
            <td><button class="btn btn-sm btn-outline-danger" onclick="removeDose(${i})">🗑️</button></td>
          </tr>`).join("")}</tbody></table>`;
}
window.removeDose=i=>{doseList.splice(i,1);renderDoses();};

function plotSimulationResult(data,log,sel){
  const time=data.Time,tr=[];
  sel.forEach(k=>{
    if(!(k in data)) return;
    tr.push({x:time,y:data[k],mode:"lines",name:k});
  });
  if(observedData){
    for(const k in observedData) if(k!=="Time"){
      tr.push({x:observedData.Time,y:observedData[k],mode:"markers",
               name:`${k} (obs)`,marker:{size:6}});
    }
  }
  Plotly.newPlot("plot",tr,{
    title:"Concentration-Time Profile",
    xaxis:{title:"Time (h)"}, yaxis:{title:"Concentration",type:log?"log":"linear"},
    legend:{orientation:"h"}, paper_bgcolor:"rgba(0,0,0,0)", plot_bgcolor:"rgba(0,0,0,0)"
  });
  document.getElementById("plot-placeholder").style.display="none";
  document.getElementById("plot").style.display="block";
}

function displayPKSummary(pk){
  const card=document.getElementById("pk-summary"); card.innerHTML="";
  const rows=Object.entries(pk).map(([c,m],i)=>`
      <tr><th>${i+1}</th><td>${c}</td>
          <td>${m.Cmax?.toFixed(4)??"-"}</td>
          <td>${m.Tmax?.toFixed(2)??"-"}</td>
          <td>${m.AUC?.toFixed(2)??"-"}</td></tr>`).join("");
  card.innerHTML=`<table class="table"><thead>
      <tr><th>#</th><th>Comp</th><th>Cmax</th><th>Tmax(h)</th><th>AUC</th></thead>
      <tbody>${rows}</tbody></table>`;
  document.getElementById("pk-summary-placeholder").style.display="none";
  card.style.display="block";
}

function getCSRFToken(){
  return (document.cookie.split("; ").find(c=>c.startsWith("csrftoken="))||"=").split("=")[1];
}

function showProcessedModal(){
  const mb=document.getElementById("modal-body");
  const comp=window._compartments?.map(c=>`<span class="badge bg-primary me-1">${c}</span>`).join("")||"";
  const par =window._parameters?.map(p=>`<span class="badge bg-secondary me-1">${p}</span>`).join("")||"";
  mb.innerHTML=`
    <h6><i class="bi bi-box"></i> Compartments</h6><div class="mb-3">${comp}</div>
    <h6><i class="bi bi-sliders"></i> Parameters</h6><div class="mb-3">${par}</div>
    <h6><i class="bi bi-file-code"></i> Processed ODEs</h6>
    <pre class="bg-light p-2 rounded small">${window._processedODE||"Parse first"}</pre>`;
  new bootstrap.Modal(document.getElementById("processedModal")).show();
}
