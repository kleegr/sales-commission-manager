/* Sales Tracker referral bridge. No card details, customer fields or service secrets are read. */
(()=>{
 if(window.__salesTrackerInstalled)return;window.__salesTrackerInstalled=true;
 const script=document.currentScript,base=new URL(script.src).origin,storage='sales-tracker-referral-v1',originalFetch=window.fetch.bind(window);
 const read=()=>{try{return JSON.parse(localStorage.getItem(storage)||'null');}catch{return null;}};
 const save=v=>{try{localStorage.setItem(storage,JSON.stringify(v));}catch{}};
 const send=async body=>{const r=await originalFetch(base+'/api/affiliate-track',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'omit',body:JSON.stringify(body),keepalive:true});if(!r.ok&&r.status!==202)throw Error('Tracking unavailable');return r.json();};
 let state=read(),initializing; const verifying=new Set();
 const query=new URLSearchParams(location.search),code=query.get('st_ref'),clickId=query.get('referralClick');
 initializing=(async()=>{if(clickId){state={clickId,expiresAt:Date.now()+86400000};save(state);}else if(code&&(!state||state.code!==code||state.expiresAt<Date.now())){state={...await send({action:'visit',code,previousClickId:state?.clickId}),code};save(state);}if(state&&state.expiresAt>Date.now()){const ready=await send({action:'ready',clickId:state.clickId});if(ready.expiresAt){state.expiresAt=ready.expiresAt;save(state);}if(state.order)void verify(state.order);}})().catch(()=>{});
 async function verify(order){await initializing;if(verifying.has(order.orderId))return;verifying.add(order.orderId);if(!state||state.expiresAt<Date.now())return;state.order=order;save(state);for(let attempt=0;attempt<8;attempt++){try{const result=await send({action:'order',clickId:state.clickId,...order});if(['test_calculated','auto_posted'].includes(result.status)){delete state.order;save(state);return;}}catch{}await new Promise(r=>setTimeout(r,attempt<2?5000:30000));}}
 function capture(response){try{const order=response?.order||response?.data?.order;if(!order?._id)return;let trackingId=order.trackingId||decodeURIComponent(document.cookie.split('; ').find(s=>s.startsWith('tr='))?.slice(3)||'');try{trackingId=JSON.parse(trackingId);}catch{}if(typeof trackingId!=='string'||!trackingId)return;void verify({orderId:order._id,trackingId});}catch{}}
 function observe(url,response){try{const parsed=new URL(url,location.href);if(!['services.leadconnectorhq.com','backend.leadconnectorhq.com'].includes(parsed.hostname)||!['/payments/orders','/funnels/order-form/order','/funnels/order-form/checkout'].includes(parsed.pathname))return;capture(response);}catch{}}
 window.fetch=function(input,init){const promise=originalFetch(input,init);const url=typeof input==='string'?input:input?.url;void promise.then(r=>{if(r.ok&&/\/(payments\/orders|funnels\/order-form\/(order|checkout))$/.test(String(url)))void r.clone().json().then(b=>observe(url,b)).catch(()=>{});}).catch(()=>{});return promise;};
 const open=XMLHttpRequest.prototype.open,sendXHR=XMLHttpRequest.prototype.send;
 XMLHttpRequest.prototype.open=function(method,url,...rest){this.__stOrderURL=String(url);return open.call(this,method,url,...rest);};
 XMLHttpRequest.prototype.send=function(...args){if(/\/(payments\/orders|funnels\/order-form\/(order|checkout))$/.test(this.__stOrderURL||''))this.addEventListener('load',()=>{try{if(this.status>=200&&this.status<300)observe(this.__stOrderURL,this.responseType==='json'?this.response:JSON.parse(this.responseText));}catch{}});return sendXHR.apply(this,args);};
// GHL's one-step checkout uses a captured fetch and writes this specific order receipt before payment.
 // Observe only its order identifier; the server independently verifies payment, source and tracking evidence.
 if(typeof Storage!=='undefined'){const setItem=Storage.prototype.setItem;Storage.prototype.setItem=function(key,value){const result=setItem.call(this,key,value);if(key==='orderResponse'){try{capture(JSON.parse(value));}catch{}}return result;};}
})();
