import {kleegrBaseUrl} from './kleegr.js';
import {DirectoryError} from './ghl-directory.js';
export const readGatewayEnabled=()=>process.env.KLEEGR_READ_GATEWAY_ENABLED==='1';
export async function gatewayPage(locationId:string,resource:string,offset=0,fetchImpl:typeof fetch=fetch){
 const key=process.env.KLEEGR_TOKEN_SERVICE_KEY;if(!key)throw new DirectoryError('gateway_not_configured','The Kleegr service connection is not configured.',503);
 const url=new URL('/api/auth/ghl/read',kleegrBaseUrl());if(url.protocol!=='https:')throw new DirectoryError('invalid_gateway','The gateway must use HTTPS.',503);url.search=new URLSearchParams({locationId,resource,offset:String(offset)}).toString();
 let r:Response;try{r=await fetchImpl(url,{headers:{'x-service-key':key},redirect:'error',signal:AbortSignal.timeout(25000)});}catch{throw new DirectoryError('gateway_unreachable','Smart Productivity could not complete this read.');}
 if(!r.ok)throw new DirectoryError(r.status===403?'scope_required':'gateway_error',r.status===403?`The connected GHL app needs permission to read ${resource}.`:'The Smart Productivity read gateway is unavailable. No direct-GHL fallback was used.',r.status===429?429:502);
 const body:any=await r.json();if(body.locationId!==locationId||body.resource!==resource||!body.payload)throw new DirectoryError('gateway_scope_mismatch','The gateway returned a different resource or location.');return body;
}
