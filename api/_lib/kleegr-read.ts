import {kleegrBaseUrl} from './kleegr.js';
import {DirectoryError} from './ghl-directory.js';
export const readGatewayEnabled=()=>process.env.KLEEGR_READ_GATEWAY_ENABLED==='1';
export async function gatewayPage(locationId:string,resource:string,offset=0,fetchImpl:typeof fetch=fetch,params:Record<string,string>={}){
 const key=process.env.KLEEGR_TOKEN_SERVICE_KEY;if(!key)throw new DirectoryError('gateway_not_configured','The Kleegr service connection is not configured.',503);
 const url=new URL('/api/auth/ghl/read',kleegrBaseUrl());if(url.protocol!=='https:')throw new DirectoryError('invalid_gateway','The gateway must use HTTPS.',503);url.search=new URLSearchParams({...params,locationId,resource,offset:String(offset)}).toString();
 let r:Response;try{r=await fetchImpl(url,{headers:{'x-service-key':key},redirect:'error',signal:AbortSignal.timeout(25000)});}catch{throw new DirectoryError('gateway_unreachable','Smart Productivity could not complete this read.');}
 if(!r.ok){
  const failure:any=await r.json().catch(()=>({}));
  if(['appointment_scope_mismatch','contact_scope_mismatch','page_scope_mismatch'].includes(failure.error))throw new DirectoryError('gateway_scope_mismatch','GHL returned a record that could not be verified against this campaign and workspace. No referral was credited.',502);
  if(failure.error==='reconnect_required')throw new DirectoryError('reconnect_required','Reconnect this sub-account in Smart Productivity, then try again.',409);
  if(failure.error==='scope_required')throw new DirectoryError('scope_required',`The connected GHL app needs permission to read ${resource}. Reconnect it in Smart Productivity after enabling the required access.`,502);
  throw new DirectoryError('gateway_error','The Smart Productivity read gateway could not complete this request. Try again or check the connection in Settings.',r.status===429?429:502);
 }
 const body:any=await r.json();if(body.locationId!==locationId||body.resource!==resource||!body.payload)throw new DirectoryError('gateway_scope_mismatch','The gateway returned a different resource or location.');return body;
}
