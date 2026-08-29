const config = window.MDAI_CONFIG || {};
const $ = (selector) => document.querySelector(selector);
const client = window.supabase?.createClient && config.supabaseUrl && config.supabasePublishableKey
  ? window.supabase.createClient(config.supabaseUrl, config.supabasePublishableKey, { auth: { persistSession: true, autoRefreshToken: true } })
  : null;

const state = { session:null, organizationId:null, role:null, properties:[], propertyId:null, tasks:[], requirements:[], assignments:[], checks:[], evidence:[], captureSessions:[], captureItems:[], selectedAssignmentId:null, pollTimer:null };
const labels = { sent:"Sent", opened:"Opened", in_progress:"In field", uploading:"Uploading", submitted:"Submitted", ai_check:"AI checking", ready_for_review:"Ready for review", retake:"Retake needed", completed:"Completed", revoked:"Replaced", expired:"Expired" };

function escapeHtml(value="") { return String(value).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#039;"); }
function label(value="") { return labels[value] || String(value).replaceAll("_"," ").replace(/\b\w/g,(letter)=>letter.toUpperCase()); }
function notify(message,kind="success") { const key=`${kind}:${message}`; const now=Date.now(); if(notify.lastKey===key&&now-(notify.lastAt||0)<8000)return; notify.lastKey=key; notify.lastAt=now; const toast=$("#toast"); toast.textContent=message; toast.className=`toast show ${kind === "error" ? "error" : ""}`; clearTimeout(notify.timer); notify.timer=setTimeout(()=>toast.classList.remove("show"),4500); }
function shortDate(value) { if(!value) return "No deadline"; const d=new Date(value); return Number.isNaN(d.valueOf()) ? value : new Intl.DateTimeFormat("en-US",{month:"short",day:"numeric",hour:"numeric",minute:"2-digit"}).format(d); }
async function invoke(body) { const {data,error}=await client.functions.invoke("field-workflow",{body}); if(error){ let message=error.message; try{message=(await error.context.clone().json()).error||message}catch{} throw new Error(message)} if(data?.error) throw new Error(data.error); return data; }
async function invokeCapture(body) { const {data,error}=await client.functions.invoke("capture-session",{body}); if(error){ let message=error.message; try{message=(await error.context.clone().json()).error||message}catch{} throw new Error(message)} if(data?.error) throw new Error(data.error); return data; }
function latestBy(items,key) { const map=new Map(); for(const item of items) if(!map.has(item[key])) map.set(item[key],item); return map; }
function propertyUrl(relative="../plans/") { return state.propertyId ? `${relative}?property=${encodeURIComponent(state.propertyId)}` : relative; }
function withTimeout(operation, message, milliseconds=18000) {
  let timer;
  return Promise.race([
    Promise.resolve(operation),
    new Promise((_,reject)=>{ timer=setTimeout(()=>reject(new Error(message)),milliseconds); }),
  ]).finally(()=>clearTimeout(timer));
}
function showBoot(title,detail,{error=false,retry=false}={}) {
  const boot=$("#boot");
  boot.hidden=false;
  boot.classList.toggle("error",error);
  $("#boot-title").textContent=title;
  $("#boot-detail").textContent=detail;
  $("#boot-actions").hidden=!retry;
  $("#boot-plans").href=propertyUrl();
  $("#app").hidden=true;
}
function showLoadFailure(error) {
  console.error("Field operations failed to load",error);
  showBoot("Field operations could not open.",error?.message||"The live field queue did not answer. Try again.",{error:true,retry:true});
}
function requireResult(result,name) {
  if(result?.error) throw new Error(`${name}: ${result.error.message||"request failed"}`);
  return result?.data||[];
}

async function initialize() {
  showBoot("Opening field operations…","Connecting the approved roadmap to the live field queue.");
  if(!client) throw new Error("Studio configuration is unavailable. Reload the page after the secure client finishes loading.");
  const {data:{session}}=await withTimeout(client.auth.getSession(),"Sign-in verification timed out. Check the connection and try again.");
  if(!session) return window.location.replace("../");
  state.session=session;
  const {data:membership,error:membershipError}=await withTimeout(client.from("organization_members").select("organization_id,role").eq("user_id",session.user.id).order("created_at").limit(1).maybeSingle(),"Organization lookup timed out. Try again.");
  if(membershipError) throw new Error(`Organization lookup: ${membershipError.message}`);
  if(!membership) throw new Error("This account has no Studio organization.");
  state.organizationId=membership.organization_id; state.role=membership.role;
  const {data:properties,error}=await withTimeout(client.from("properties").select("id,name,active_baseline_id,workflow_state").eq("organization_id",state.organizationId).order("created_at"),"Project lookup timed out. Try again.");
  if(error) throw error; state.properties=properties||[];
  $("#property-select").innerHTML=state.properties.map(p=>`<option value="${p.id}">${escapeHtml(p.name)}</option>`).join("");
  const requested=new URLSearchParams(location.search).get("property"); state.propertyId=state.properties.find(p=>p.id===requested)?.id||state.properties[0]?.id;
  if(!state.propertyId) throw new Error("Create a project before opening field operations.");
  $("#property-select").value=state.propertyId;
  await load();
  $("#boot").hidden=true;
  $("#app").hidden=false;
}

async function load() {
  const property=state.properties.find(p=>p.id===state.propertyId);
  window.MDAIRecentProjects?.remember({id:property?.id,name:property?.name});
  history.replaceState({},"",`${location.pathname}?property=${encodeURIComponent(state.propertyId)}`);
  document.querySelectorAll('a[href="../plans/"],a[href^="../plans/?property="]').forEach(link=>{link.href=propertyUrl()});
  document.querySelectorAll('a[href="./"],a[href^="./?property="]').forEach(link=>{link.href=`./?property=${encodeURIComponent(state.propertyId)}`});
  // Same reason as the plans page: going back must land in the project, not in the list.
  document.querySelectorAll('a[href="../"],a[href^="../?property="]').forEach(link=>{link.href=`../?property=${encodeURIComponent(state.propertyId)}`});
  const baselineId=property?.active_baseline_id;
  const [assignmentResult,checkResult,taskResult,requirementResult,evidenceResult,documentResult]=await withTimeout(Promise.all([
    client.from("field_assignments").select("*").eq("organization_id",state.organizationId).eq("property_id",state.propertyId).order("created_at",{ascending:false}),
    client.from("field_quality_checks").select("*").eq("organization_id",state.organizationId).eq("property_id",state.propertyId).order("created_at",{ascending:false}),
    baselineId ? client.from("capture_tasks").select("*").eq("baseline_id",baselineId) : Promise.resolve({data:[],error:null}),
    baselineId ? client.from("capture_requirements").select("*").eq("baseline_id",baselineId) : Promise.resolve({data:[],error:null}),
    client.from("evidence_items").select("id,field_assignment_id,original_filename,mime_type,byte_size,created_at").eq("organization_id",state.organizationId).eq("property_id",state.propertyId).not("field_assignment_id","is",null).order("created_at",{ascending:false}),
    client.from("project_documents").select("id,field_assignment_id,original_filename,mime_type,byte_size,created_at").eq("organization_id",state.organizationId).eq("property_id",state.propertyId).not("field_assignment_id","is",null).order("created_at",{ascending:false}),
  ]),"The live field queue timed out. No data was changed; try again.",20000);
  state.assignments=requireResult(assignmentResult,"Assignments");
  state.checks=requireResult(checkResult,"Quality checks");
  state.tasks=requireResult(taskResult,"Capture tasks");
  state.requirements=requireResult(requirementResult,"Capture requirements");
  state.captureSessions=[];state.captureItems=[];
  const evidence=requireResult(evidenceResult,"Submitted evidence");
  const documents=requireResult(documentResult,"Submitted documents");
  state.evidence=[
    ...evidence.map(item=>({...item,record_type:"evidence"})),
    ...documents.map(item=>({...item,record_type:"project_document"})),
  ].sort((left,right)=>String(right.created_at).localeCompare(String(left.created_at)));
  render();
}

function render() {
  const counts={ toSend:state.tasks.filter(t=>t.status==="ready"&&!state.assignments.some(a=>a.capture_task_id===t.id&&a.status!=="revoked")).length, field:0, check:0, retake:0, review:0, completed:0 };
  state.assignments.forEach(a=>{ if(["sent","opened","in_progress","uploading"].includes(a.status)) counts.field++; else if(a.status==="ai_check") counts.check++; else if(a.status==="retake") counts.retake++; else if(a.status==="ready_for_review") counts.review++; else if(a.status==="completed") counts.completed++; });
  const metrics=[["Ready to send",counts.toSend,"Approved tasks"],["In the field",counts.field,"Worker active"],["AI check",counts.check,"Automatic review"],["Retake",counts.retake,"Needs action"],["Human review",counts.review,"Decision waiting"],["Complete",counts.completed,"Verified tasks"]];
  $("#metrics").innerHTML=metrics.map(([name,count,copy])=>`<article class="metric"><span>${name}</span><strong>${count}</strong><small>${copy}</small></article>`).join("");
  renderCaptureSessions();
  const nextStep=$("#next-step");
  nextStep.hidden=counts.toSend===0;
  if(counts.toSend>0) {
    $("#next-step-title").textContent=`${counts.toSend} field task${counts.toSend===1?" is":"s are"} ready to send.`;
    $("#next-step-copy").textContent="Choose the first approved task, enter the worker's name and email, then send the private field link.";
    const activeBaseline=state.properties.find(p=>p.id===state.propertyId)?.active_baseline_id;
    $("#next-step-link").href=activeBaseline?`${propertyUrl()}&baseline=${encodeURIComponent(activeBaseline)}`:propertyUrl();
  }
  const filter=$("#status-filter").value; const latestChecks=latestBy(state.checks,"assignment_id");
  const visible=state.assignments.filter(a=>filter==="all"||(filter==="active"&&["sent","opened","in_progress","uploading","ai_check"].includes(a.status))||(filter==="review"&&a.status==="ready_for_review")||a.status===filter);
  $("#queue").innerHTML=visible.length ? visible.map(a=>{
    const task=state.tasks.find(t=>t.id===a.capture_task_id); const req=state.requirements.find(r=>r.id===(task?.requirement_id||a.requirement_id)); const qc=latestChecks.get(a.id); const summary=qc?.result?.summary|| (a.status==="ai_check"?"Checking the upload now…":"No automatic result yet.");
    const reviewable=["ready_for_review","retake"].includes(a.status);
    const delivery=a.email_delivery_state==="sent"?"Email provider accepted":a.email_delivery_state==="failed"?"Email failed — use private link":"Private link only";
    return `<article class="assignment"><div><h3>${escapeHtml(req?.title||a.instructions_snapshot?.title||"Field capture")}</h3><p>${escapeHtml(a.instructions_snapshot?.location?.name||"Project-wide")}</p></div><div class="cell"><span>Worker</span><strong>${escapeHtml(a.worker_name)}</strong><small>${escapeHtml(a.worker_email)}</small></div><div class="cell"><span>Due</span><strong>${escapeHtml(shortDate(a.due_at))}</strong><small title="${escapeHtml(a.email_delivery_error||"")}">${escapeHtml(delivery)}</small></div><div class="qc"><strong>${escapeHtml(qc?label(qc.state):"Waiting")}</strong>${escapeHtml(summary)}</div><div class="cell"><span class="status ${escapeHtml(a.status)}">${escapeHtml(label(a.status))}</span>${reviewable?`<button class="button secondary" data-review="${a.id}">Review</button>`:""}</div></article>`;
  }).join("") : `<div class="empty"><h3>${counts.toSend?"The roadmap is ready; no task has been sent yet.":"No assignments in this view."}</h3><p>${counts.toSend?"Use the Next action above to send the first task.":"New field work and completed reviews will appear here."}</p></div>`;
  document.querySelectorAll("[data-review]").forEach(button=>button.addEventListener("click",()=>openReview(button.dataset.review)));
}

function renderCaptureSessions() {
  $("#capture-sessions").hidden=true;
}

async function revokeCaptureSession(id) {
  if(!confirm("Revoke this private upload link? Files already uploaded remain in the project record."))return;
  try{await invokeCapture({action:"revoke",session_id:id});notify("Private capture link revoked.");await load();}catch(error){notify(error.message,"error")}
}

function openCaptureDialog() {
  $("#capture-link-result").hidden=true;
  $("#create-capture-session").hidden=false;
  $("#create-capture-session").disabled=false;
  $("#create-capture-session").textContent="Create & send";
  $("#capture-dialog").showModal();
}

async function createCaptureSession() {
  const name=$("#capture-recipient-name").value.trim();
  const email=$("#capture-recipient-email").value.trim();
  const sessionLabel=$("#capture-label").value.trim();
  if(!name)return $("#capture-recipient-name").focus();
  if(!/^\S+@\S+\.\S+$/.test(email))return $("#capture-recipient-email").focus();
  const button=$("#create-capture-session"); button.disabled=true; button.textContent="Creating…";
  try {
    const result=await invokeCapture({action:"create",property_id:state.propertyId,recipient_name:name,recipient_email:email,label:sessionLabel||"Room capture session"});
    $("#capture-link").value=result.link; $("#open-capture-link").href=result.link;
    $("#capture-email-state").textContent=result.email_state==="sent"?"Email provider accepted the message.":result.email_error||"Link created. Copy and send it manually.";
    $("#capture-link-result").hidden=false; button.hidden=true; notify("Private room capture session created."); await load();
  } catch(error) { notify(error.message,"error"); button.disabled=false; button.textContent="Create & send"; }
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

$("#property-select").addEventListener("change",async()=>{state.propertyId=$("#property-select").value;try{await load()}catch(error){notify(error.message,"error")}});
$("#new-capture-session").addEventListener("click",openCaptureDialog);
$("#create-capture-session").addEventListener("click",createCaptureSession);
$("#copy-capture-link").addEventListener("click",async()=>{try{await navigator.clipboard.writeText($("#capture-link").value);notify("Private capture link copied.")}catch{notify("Copy failed. Select the link and copy it manually.","error")}});
$("#status-filter").addEventListener("change",render); $("#refresh").addEventListener("click",()=>load().catch(e=>notify(e.message,"error")));
$("#complete-task").addEventListener("click",()=>decide("complete")); $("#request-retake").addEventListener("click",()=>decide("retake"));
$("#sign-out").addEventListener("click",async()=>{await client.auth.signOut();location.replace("../")});
$("#boot-retry").addEventListener("click",()=>initialize().catch(showLoadFailure));
initialize().catch(showLoadFailure);

document.addEventListener("visibilitychange",()=>{ if(document.visibilityState==="visible"&&state.propertyId) load().catch(error=>console.warn("Background field refresh interrupted",error)); });
state.pollTimer=window.setInterval(()=>{ if(document.visibilityState==="visible"&&state.propertyId) load().catch(console.error); },15000);

/* Day and night are one studio: the palette swaps, the record does not.
   The choice is shared with the landing site through the same storage key,
   and the pre-paint script in <head> applies it before the first frame. */
{
  const themeToggle = document.querySelector("#theme-toggle");
  const reflectTheme = () => {
    if (themeToggle) themeToggle.textContent = document.documentElement.dataset.theme === "light" ? "☀ Day" : "☾ Night";
  };
  themeToggle?.addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
    document.documentElement.dataset.theme = next;
    try { window.localStorage.setItem("mdai-theme", next); } catch (_) { /* private browsing: the choice lasts the visit */ }
    reflectTheme();
  });
  reflectTheme();
}
