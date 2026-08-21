import { createClient } from "npm:@supabase/supabase-js@2";
import { AGENT_CONTRACT_VERSION } from "../_shared/agent-contracts.ts";
import { signedObjectReadUrl } from "../_shared/aws-object-store.ts";

const allowedOrigins = new Set(["https://measureddecision.com", "https://www.measureddecision.com", "http://localhost:8080", "http://127.0.0.1:8080"]);
function cors(request: Request) { const origin=request.headers.get("origin")||""; return { "Access-Control-Allow-Origin":allowedOrigins.has(origin)?origin:"https://measureddecision.com", "Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods":"POST, OPTIONS", Vary:"Origin" }; }
function json(request:Request,body:unknown,status=200){return new Response(JSON.stringify(body),{status,headers:{...cors(request),"Content-Type":"application/json","Cache-Control":"no-store"}})}
function fail(message:string,status=400):never{throw Object.assign(new Error(message),{status})}
function isUuid(value:unknown){return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value||""))}
function sameIds(left:string[]=[],right:string[]=[]){return left.length===right.length&&new Set(left).size===new Set(right).size&&left.every(id=>right.includes(id))}

Deno.serve(async(request)=>{
  if(request.method==="OPTIONS")return new Response("ok",{headers:cors(request)});
  if(request.method!=="POST")return json(request,{error:"Method not allowed"},405);
  const supabaseUrl=Deno.env.get("SUPABASE_URL"); const anonKey=Deno.env.get("SUPABASE_ANON_KEY")||Deno.env.get("SUPABASE_PUBLISHABLE_KEY"); const serviceKey=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if(!supabaseUrl||!anonKey||!serviceKey)return json(request,{error:"Server configuration is incomplete"},500);
  const authorization=request.headers.get("Authorization")||"";
  const userClient=createClient(supabaseUrl,anonKey,{global:{headers:{Authorization:authorization}},auth:{persistSession:false}});
  const admin=createClient(supabaseUrl,serviceKey,{auth:{persistSession:false}});
  try{
    const {data:userData,error:userError}=await userClient.auth.getUser(); if(userError||!userData.user)fail("Authentication required",401); const user=userData.user;
    const body=await request.json(); const action=String(body?.action||""); const propertyId=String(body?.property_id||"");

    async function projectAccess(id:string){
      if(!isUuid(id))fail("A valid project is required");
      const {data:property}=await admin.from("properties").select("*").eq("id",id).maybeSingle(); if(!property)fail("Project not found",404);
      const {data:membership}=await admin.from("organization_members").select("role").eq("organization_id",property.organization_id).eq("user_id",user.id).maybeSingle();
      if(!membership)fail("Project access is required",403); return {property,role:membership.role as string};
    }

    if(action==="status"){
      const {property}=await projectAccess(propertyId);
      const {data:releases}=await admin.from("vision_releases").select("id,version,state,manifest,created_at,approved_at").eq("organization_id",property.organization_id).eq("property_id",property.id).order("version",{ascending:false}).limit(10);
      return json(request,{releases:releases||[]});
    }

    if(action==="build"){
      const {property,role}=await projectAccess(propertyId); if(!["owner","admin","reviewer"].includes(role))fail("Reviewer access is required",403);
      const baselineId=property.active_baseline_id||null;
      const [{data:baseline},{data:spaces},{data:evidence},{data:suggestions},{data:tasks}]=await Promise.all([
        baselineId?admin.from("document_baselines").select("id,version,state,project_summary,approved_at").eq("id",baselineId).maybeSingle():Promise.resolve({data:null}),
        admin.from("spaces").select("id,parent_space_id,name,building,level,review_state").eq("organization_id",property.organization_id).eq("property_id",property.id).is("deleted_at",null).order("created_at"),
        admin.from("evidence_items").select("id,space_id,capture_task_id,baseline_id,storage_path,storage_provider,storage_bucket,original_filename,media_type,mime_type,byte_size,sha256,captured_at,created_at,source_metadata").eq("organization_id",property.organization_id).eq("property_id",property.id).order("created_at"),
        admin.from("ai_suggestions").select("id,space_id,body,evidence_ids,confidence,created_at,agent_key,agent_contract_version").eq("organization_id",property.organization_id).eq("property_id",property.id).eq("suggestion_type","room_interpretation").order("created_at",{ascending:false}),
        baselineId?admin.from("capture_tasks").select("id,status,verified_by,verified_at,reviewer_note").eq("baseline_id",baselineId):Promise.resolve({data:[]}),
      ]);
      const suggestionIds=(suggestions||[]).map(item=>item.id); const {data:reviews}=suggestionIds.length?await admin.from("suggestion_reviews").select("suggestion_id,state,edited_body,reviewer_note,reviewed_by,reviewed_at").in("suggestion_id",suggestionIds):{data:[]};
      const blockers=new Set<string>(); if(!baseline||baseline.state!=="approved")blockers.add("approved_plan_baseline_required");
      const taskMap=new Map((tasks||[]).map(task=>[task.id,task]));
      const manifestSpaces=(spaces||[]).map(space=>{
        const spaceEvidence=(evidence||[]).filter(item=>item.space_id===space.id); if(!spaceEvidence.length)return null;
        if(space.review_state!=="confirmed")blockers.add(`space_review_required:${space.id}`);
        for(const item of spaceEvidence){const task=item.capture_task_id?taskMap.get(item.capture_task_id):null;if(task&&task.status!=="verified")blockers.add(`field_task_verification_required:${task.id}`)}
        const evidenceIds=spaceEvidence.map(item=>item.id); const suggestion=(suggestions||[]).find(item=>item.space_id===space.id&&sameIds(item.evidence_ids||[],evidenceIds));
        const review=suggestion?(reviews||[]).find(item=>item.suggestion_id===suggestion.id):null;
        if(!suggestion)blockers.add(`current_interpretation_required:${space.id}`); else if(review?.state!=="confirmed")blockers.add(`interpretation_review_required:${space.id}`);
        return { id:space.id,parentSpaceId:space.parent_space_id,name:space.name,building:space.building,level:space.level,reviewState:space.review_state,
          evidence:spaceEvidence.map(item=>({id:item.id,captureTaskId:item.capture_task_id,storageProvider:item.storage_provider,storageBucket:item.storage_bucket,storagePath:item.storage_path,filename:item.original_filename,mediaType:item.media_type,mimeType:item.mime_type,byteSize:item.byte_size,sha256:item.sha256,capturedAt:item.captured_at||item.created_at,sourceMetadata:item.source_metadata||{}})),
          interpretation:suggestion?{suggestionId:suggestion.id,body:review?.edited_body||suggestion.body,evidenceIds:suggestion.evidence_ids,confidence:suggestion.confidence,agentKey:suggestion.agent_key,agentContractVersion:suggestion.agent_contract_version,review:review||null}:null };
      }).filter(Boolean);
      if(!manifestSpaces.length)blockers.add("verified_spatial_evidence_required");
      const {data:last}=await admin.from("vision_releases").select("version").eq("property_id",property.id).order("version",{ascending:false}).limit(1).maybeSingle(); const version=Number(last?.version||0)+1;
      const manifest={schema:"com.measureddecision.vision-release/1.0",packageType:"governed-vision-package",generatedAt:new Date().toISOString(),agent:{key:"verification_guard",capability:"spatial_release",contractVersion:AGENT_CONTRACT_VERSION},baseline:baseline?{id:baseline.id,version:baseline.version,state:baseline.state,approvedAt:baseline.approved_at,summary:baseline.project_summary}:null,property:{id:property.id,name:property.name,address:property.address,accessClassification:property.access_classification},spaces:manifestSpaces,blockers:[...blockers],governance:{originalsPreserved:true,ephemeralMediaDelivery:true,humanApprovalRequired:true}};
      const {data:release,error}=await admin.from("vision_releases").insert({organization_id:property.organization_id,property_id:property.id,baseline_id:baselineId,version,state:"draft",manifest,created_by:user.id,agent_key:"verification_guard",agent_contract_version:AGENT_CONTRACT_VERSION}).select("*").single(); if(error||!release)throw error||new Error("Vision release could not be created");
      await admin.from("audit_events").insert({organization_id:property.organization_id,actor_id:user.id,action:"vision_release.built",entity_type:"vision_release",entity_id:release.id,detail:{version,blockers:[...blockers],agent_contract_version:AGENT_CONTRACT_VERSION}});
      return json(request,{release:{id:release.id,version:release.version,state:release.state,blockers:[...blockers],created_at:release.created_at}});
    }

    if(action==="approve"){
      const releaseId=String(body?.release_id||""); if(!isUuid(releaseId))fail("A valid release is required");
      const {data:release}=await admin.from("vision_releases").select("*").eq("id",releaseId).maybeSingle(); if(!release)fail("Vision release not found",404);
      const {role}=await projectAccess(release.property_id); if(!["owner","admin","reviewer"].includes(role))fail("Reviewer access is required",403);
      const {data:approved,error}=await admin.rpc("approve_vision_release",{target_release:release.id,approver:user.id}); if(error)throw error;
      await admin.from("audit_events").insert({organization_id:release.organization_id,actor_id:user.id,action:"vision_release.approved",entity_type:"vision_release",entity_id:release.id,detail:{version:release.version}});
      return json(request,{release:approved});
    }

    if(action==="get"){
      const {property}=await projectAccess(propertyId); const releaseId=body?.release_id?String(body.release_id):null;
      let query=admin.from("vision_releases").select("*").eq("organization_id",property.organization_id).eq("property_id",property.id).eq("state","approved"); if(releaseId)query=query.eq("id",releaseId); const {data:release}=await query.order("version",{ascending:false}).limit(1).maybeSingle(); if(!release)fail("No approved Vision release is available",404);
      const media=[] as Array<Record<string,unknown>>; for(const space of release.manifest?.spaces||[])for(const item of space.evidence||[]){let url="";if(item.storageProvider==="aws-s3")url=await signedObjectReadUrl(item.storagePath,3600);else{const {data}=await admin.storage.from(item.storageBucket||"property-evidence").createSignedUrl(item.storagePath,3600);url=data?.signedUrl||""}media.push({evidenceId:item.id,url,expiresAt:new Date(Date.now()+3600000).toISOString()})}
      return json(request,{release:{id:release.id,version:release.version,state:release.state,approvedAt:release.approved_at},manifest:release.manifest,media});
    }
    return json(request,{error:"Unsupported action"},400);
  }catch(error){console.error("vision-release",error);return json(request,{error:error instanceof Error?error.message:"Vision release failed"},Number((error as {status?:number})?.status)||500)}
});
