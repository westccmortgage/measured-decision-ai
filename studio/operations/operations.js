const config = window.MDAI_CONFIG || {};
const $ = (selector) => document.querySelector(selector);
const client = window.supabase?.createClient && config.supabaseUrl && config.supabasePublishableKey
  ? window.supabase.createClient(config.supabaseUrl, config.supabasePublishableKey, { auth: { persistSession: true, autoRefreshToken: true } })
  : null;

const state = { session:null, organizationId:null, role:null, properties:[], propertyId:null, tasks:[], requirements:[], assignments:[], checks:[], evidence:[], selectedAssignmentId:null, pollTimer:null };
const labels = { sent:"Sent", opened:"Opened", in_progress:"In field", uploading:"Uploading", submitted:"Submitted", ai_check:"AI checking", ready_for_review:"Ready for review", retake:"Retake needed", completed:"Completed", revoked:"Replaced", expired:"Expired" };

function escapeHtml(value="") { return String(value).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#039;"); }
function label(value="") { return labels[value] || String(value).replaceAll("_"," ").replace(/\b\w/g,(letter)=>letter.toUpperCase()); }
function notify(message,kind="success") { const toast=$("#toast"); toast.textContent=message; toast.className=`toast show ${kind === "error" ? "error" : ""}`; clearTimeout(notify.timer); notify.timer=setTimeout(()=>toast.classList.remove("show"),4500); }
function shortDate(value) { if(!value) return "No deadline"; const d=new Date(value); return Number.isNaN(d.valueOf()) ? value : new Intl.DateTimeFormat("en-US",{month:"short",day:"numeric",hour:"numeric",minute:"2-digit"}).format(d); }
async function invoke(body) { const {data,error}=await client.functions.invoke("field-workflow",{body}); if(error){ let message=error.message; try{message=(await error.context.clone().json()).error||message}catch{} throw new Error(message)} if(data?.error) throw new Error(data.error); return data; }
function latestBy(items,key) { const map=new Map(); for(const item of items) if(!map.has(item[key])) map.set(item[key],item); return map; }

async function initialize() {
  if(!client) return $("#boot").textContent="Studio configuration is unavailable.";
  const {data:{session}}=await client.auth.getSession();
  if(!session) return window.location.replace("../");
  state.session=session;
  const {data:membership}=await client.from("organization_members").select("organization_id,role").eq("user_id",session.user.id).order("created_at").limit(1).maybeSingle();
  if(!membership) return $("#boot").textContent="This account has no Studio organization.";
  state.organizationId=membership.organization_id; state.role=membership.role;
  const {data:properties,error}=await client.from("properties").select("id,name,active_baseline_id,workflow_state").eq("organization_id",state.organizationId).order("created_at");
  if(error) throw error; state.properties=properties||[];
  $("#property-select").innerHTML=state.properties.map(p=>`<option value="${p.id}">${escapeHtml(p.name)}</option>`).join("");
  const requested=new URLSearchParams(location.search).get("property"); state.propertyId=state.properties.find(p=>p.id===requested)?.id||state.properties[0]?.id;
  if(!state.propertyId) return $("#boot").textContent="Create a project first.";
  $("#property-select").value=state.propertyId; $("#boot").hidden=true; $("#app").hidden=false; await load();
}

async function load() {
  const property=state.properties.find(p=>p.id===state.propertyId);
  history.replaceState({},"",`${location.pathname}?property=${encodeURIComponent(state.propertyId)}`);
  const baselineId=property?.active_baseline_id;
  const [assignmentResult,checkResult,taskResult,requirementResult,evidenceResult,documentResult]=await Promise.all([
    client.from("field_assignments").select("*").eq("organization_id",state.organizationId).eq("property_id",state.propertyId).order("created_at",{ascending:false}),
    client.from("field_quality_checks").select("*").eq("organization_id",state.organizationId).eq("property_id",state.propertyId).order("created_at",{ascending:false}),
    baselineId ? client.from("capture_tasks").select("*").eq("baseline_id",baselineId) : Promise.resolve({data:[],error:null}),
    baselineId ? client.from("capture_requirements").select("*").eq("baseline_id",baselineId) : Promise.resolve({data:[],error:null}),
    client.from("evidence_items").select("id,field_assignment_id,original_filename,mime_type,byte_size,created_at").eq("organization_id",state.organizationId).eq("property_id",state.propertyId).not("field_assignment_id","is",null).order("created_at",{ascending:false}),
    client.from("project_documents").select("id,field_assignment_id,original_filename,mime_type,byte_size,created_at").eq("organization_id",state.organizationId).eq("property_id",state.propertyId).not("field_assignment_id","is",null).order("created_at",{ascending:false}),
  ]);
  const error=assignmentResult.error||checkResult.error||taskResult.error||requirementResult.error||evidenceResult.error||documentResult.error; if(error) throw error;
  state.assignments=assignmentResult.data||[]; state.checks=checkResult.data||[]; state.tasks=taskResult.data||[]; state.requirements=requirementResult.data||[];
  state.evidence=[
    ...(evidenceResult.data||[]).map(item=>({...item,record_type:"evidence"})),
    ...(documentResult.data||[]).map(item=>({...item,record_type:"project_document"})),
  ].sort((left,right)=>String(right.created_at).localeCompare(String(left.created_at)));
  render();
}

function render() {
  const counts={ toSend:state.tasks.filter(t=>t.status==="ready"&&!state.assignments.some(a=>a.capture_task_id===t.id&&a.status!=="revoked")).length, field:0, check:0, retake:0, review:0, completed:0 };
  state.assignments.forEach(a=>{ if(["sent","opened","in_progress","uploading"].includes(a.status)) counts.field++; else if(a.status==="ai_check") counts.check++; else if(a.status==="retake") counts.retake++; else if(a.status==="ready_for_review") counts.review++; else if(a.status==="completed") counts.completed++; });
  const metrics=[["Ready to send",counts.toSend,"Approved tasks"],["In the field",counts.field,"Worker active"],["AI check",counts.check,"Automatic review"],["Retake",counts.retake,"Needs action"],["Human review",counts.review,"Decision waiting"],["Complete",counts.completed,"Verified tasks"]];
  $("#metrics").innerHTML=metrics.map(([name,count,copy])=>`<article class="metric"><span>${name}</span><strong>${count}</strong><small>${copy}</small></article>`).join("");
  const filter=$("#status-filter").value; const latestChecks=latestBy(state.checks,"assignment_id");
  const visible=state.assignments.filter(a=>filter==="all"||(filter==="active"&&["sent","opened","in_progress","uploading","ai_check"].includes(a.status))||(filter==="review"&&a.status==="ready_for_review")||a.status===filter);
  $("#queue").innerHTML=visible.length ? visible.map(a=>{
    const task=state.tasks.find(t=>t.id===a.capture_task_id); const req=state.requirements.find(r=>r.id===(task?.requirement_id||a.requirement_id)); const qc=latestChecks.get(a.id); const summary=qc?.result?.summary|| (a.status==="ai_check"?"Checking the upload now…":"No automatic result yet.");
    const reviewable=["ready_for_review","retake"].includes(a.status);
    return `<article class="assignment"><div><h3>${escapeHtml(req?.title||a.instructions_snapshot?.title||"Field capture")}</h3><p>${escapeHtml(a.instructions_snapshot?.location?.name||"Project-wide")}</p></div><div class="cell"><span>Worker</span><strong>${escapeHtml(a.worker_name)}</strong><small>${escapeHtml(a.worker_email)}</small></div><div class="cell"><span>Due</span><strong>${escapeHtml(shortDate(a.due_at))}</strong><small>${escapeHtml(a.email_delivery_state==="sent"?"Email delivered":"Private link")}</small></div><div class="qc"><strong>${escapeHtml(qc?label(qc.state):"Waiting")}</strong>${escapeHtml(summary)}</div><div class="cell"><span class="status ${escapeHtml(a.status)}">${escapeHtml(label(a.status))}</span>${reviewable?`<button class="button secondary" data-review="${a.id}">Review</button>`:""}</div></article>`;
  }).join("") : '<div class="empty"><h3>No assignments in this view.</h3><p>Open Project plans and send a ready capture task to a field worker.</p></div>';
  document.querySelectorAll("[data-review]").forEach(button=>button.addEventListener("click",()=>openReview(button.dataset.review)));
}

function openReview(id) {
  state.selectedAssignmentId=id;
  const assignment=state.assignments.find(a=>a.id===id);
  const check=state.checks.find(c=>c.assignment_id===id);
  const evidence=state.evidence.filter(item=>item.field_assignment_id===id);
  $("#review-title").textContent=assignment?.instructions_snapshot?.title||"Review submission";
  const checks=Array.isArray(check?.result?.checks)?check.result.checks:[];
  $("#qc-summary").innerHTML=`<p>${escapeHtml(check?.result?.summary||"Automatic check did not return a summary. Inspect the submitted material.")}</p>${checks.map(c=>`<div class="check"><strong class="${escapeHtml(c.state)}">${escapeHtml(label(c.state))}</strong><span>${escapeHtml(c.note)}</span></div>`).join("")}`;
  $("#review-evidence").innerHTML=evidence.length
    ? `<h3>Submitted material</h3>${evidence.map(item=>`<button type="button" class="evidence-file" data-evidence="${item.id}" data-entity="${escapeHtml(item.record_type)}"><span>${escapeHtml(item.original_filename)}</span><small>${escapeHtml(item.record_type==="project_document"?"Document":item.mime_type)} · ${Math.max(1,Math.round(Number(item.byte_size||0)/1048576))} MB</small><strong>Open →</strong></button>`).join("")}`
    : '<p class="no-evidence">No submitted files were found for this assignment.</p>';
  $("#review-evidence").querySelectorAll("[data-evidence]").forEach(button=>button.addEventListener("click",()=>openEvidence(button.dataset.evidence,button.dataset.entity,button)));
  $("#review-note").value=check?.result?.retake_instruction||"";
  $("#review-dialog").showModal();
}

async function openEvidence(id,entityType,button) {
  const strong=button.querySelector("strong"); const prior=strong.textContent;
  const preview=window.open("","_blank");
  if(preview) preview.opener=null;
  button.disabled=true; strong.textContent="Opening…";
  try {
    if(!window.MDAIObjectStorage) throw new Error("Secure media service is unavailable");
    const url=await window.MDAIObjectStorage.getSignedUrl(client,entityType||"evidence",id);
    if(preview) preview.location.href=url; else location.href=url;
  } catch(error) { if(preview) preview.close(); notify(error.message,"error"); }
  finally { button.disabled=false; strong.textContent=prior; }
}
async function decide(decision) { const id=state.selectedAssignmentId; if(!id)return; try{ await invoke({action:"review_decision",assignment_id:id,decision,note:$("#review-note").value.trim()}); $("#review-dialog").close(); notify(decision==="complete"?"Task completed.":"Retake requested."); await load(); }catch(error){notify(error.message,"error")} }

$("#property-select").addEventListener("change",async()=>{state.propertyId=$("#property-select").value;await load()});
$("#status-filter").addEventListener("change",render); $("#refresh").addEventListener("click",()=>load().catch(e=>notify(e.message,"error")));
$("#complete-task").addEventListener("click",()=>decide("complete")); $("#request-retake").addEventListener("click",()=>decide("retake"));
$("#sign-out").addEventListener("click",async()=>{await client.auth.signOut();location.replace("../")});
initialize().catch(error=>{$("#boot").textContent=error.message;console.error(error)});

document.addEventListener("visibilitychange",()=>{ if(document.visibilityState==="visible"&&state.propertyId) load().catch(error=>notify(error.message,"error")); });
state.pollTimer=window.setInterval(()=>{ if(document.visibilityState==="visible"&&state.propertyId) load().catch(console.error); },15000);
