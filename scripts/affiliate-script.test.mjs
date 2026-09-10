import vm from 'node:vm';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const code=await readFile(new URL('../public/affiliate.js',import.meta.url),'utf8');
const events=[],saved=new Map();
const nativeFetch=async(url,init)=>{if(String(url).includes('/api/affiliate-track')){const b=JSON.parse(init.body);events.push(b);return Response.json(b.action==='visit'?{clickId:'random-click',expiresAt:Date.now()+100000}:b.action==='order'?{status:'test_calculated'}:{ok:true});}return Response.json({order:{_id:'order-test',trackingId:'order-tracking-123456'}});};
class Storage{setItem(k,v){this[k]=v;}}
class XHR{open(){}send(){}addEventListener(){}}
const window={fetch:nativeFetch};const context={window,document:{currentScript:{src:'https://tracker.example/affiliate.js'},cookie:''},location:{href:'https://example.com/checkout?st_ref=affiliate-code',search:'?st_ref=affiliate-code'},localStorage:{getItem:k=>saved.get(k),setItem:(k,v)=>saved.set(k,v)},Storage,XMLHttpRequest:XHR,URL,URLSearchParams,Date,JSON,Promise,decodeURIComponent,setTimeout};
vm.runInNewContext(code,context);await new Promise(r=>setTimeout(r,10));
const result=await window.fetch('https://services.leadconnectorhq.com/payments/orders',{method:'POST'});assert.equal(result.status,200);await new Promise(r=>setTimeout(r,10));
assert.deepEqual(events.map(e=>e.action),['visit','ready','order']);assert.deepEqual(events[2],{action:'order',clickId:'random-click',orderId:'order-test',trackingId:'order-tracking-123456'});
await window.fetch('https://services.leadconnectorhq.com/payments/stripe/verify',{method:'POST',body:'card details not observed'});await new Promise(r=>setTimeout(r,10));assert.equal(events.length,3);
await window.fetch('https://attacker.example/payments/orders',{method:'POST'});await new Promise(r=>setTimeout(r,10));assert.equal(events.length,3);
vm.runInNewContext(code,context);await new Promise(r=>setTimeout(r,10));assert.equal(events.length,3);
console.log('Affiliate bridge preserves checkout responses, captures only scoped order identifiers, ignores card/payment and foreign requests, and installs once.');

const storage=new Storage();storage.setItem('orderResponse',JSON.stringify({order:{_id:'one-step-order',trackingId:'one-step-tracking-12345'},contact:{email:'not-collected@example.com'}}));await new Promise(r=>setTimeout(r,10));assert.deepEqual(events.at(-1),{action:'order',clickId:'random-click',orderId:'one-step-order',trackingId:'one-step-tracking-12345'});assert.equal(events.length,4);storage.setItem('contactResponse',JSON.stringify({email:'not-collected@example.com'}));await new Promise(r=>setTimeout(r,10));assert.equal(events.length,4);console.log('GHL one-step saved receipt is captured without sending customer fields.');

// A checkout bundle may retain fetch before the bridge installs and persist only encrypted receipts.
const jsonEvents=[];
class OrderResponse {constructor(url,body){this.url=url;this.body=body;}async json(){return this.body;}async text(){return JSON.stringify(this.body);}}
const cachedFetch=async url=>new OrderResponse(url,{order:{_id:'early-fetch-order',trackingId:'early-fetch-tracking-12345'},contact:{email:'never-send@example.com'}});
const jsonContext={...context,Response:OrderResponse,window:{fetch:async(url,init)=>{const body=JSON.parse(init.body);jsonEvents.push(body);return Response.json(body.action==='visit'?{clickId:'early-click',expiresAt:Date.now()+100000}:body.action==='order'?{status:'test_calculated'}:{ok:true});}},localStorage:{getItem:()=>null,setItem:()=>{}}};
vm.runInNewContext(code,jsonContext);await new Promise(r=>setTimeout(r,10));
const decoded=await (await cachedFetch('https://services.leadconnectorhq.com/funnels/order-form/order')).json();
await new Promise(r=>setTimeout(r,10));
assert.equal(decoded.contact.email,'never-send@example.com');
assert.deepEqual(jsonEvents.at(-1),{action:'order',clickId:'early-click',orderId:'early-fetch-order',trackingId:'early-fetch-tracking-12345'});
const before=jsonEvents.length;
await (await cachedFetch('https://services.leadconnectorhq.com/payments/stripe/verify')).json();
await (await cachedFetch('https://attacker.example/funnels/order-form/order')).json();
assert.equal(jsonEvents.length,before);
console.log('Pre-captured fetch is observed through exact order-response JSON decoding; customer fields and unrelated responses are untouched.');

const textResponse=new OrderResponse('https://backend.leadconnectorhq.com/funnels/order-form/order',{order:{_id:'text-order',trackingId:'text-tracking-123456'},contact:{email:'never-send@example.com'}});
const textBody=await textResponse.text();await new Promise(r=>setTimeout(r,10));
assert.equal(JSON.parse(textBody).contact.email,'never-send@example.com');
assert.deepEqual(jsonEvents.at(-1),{action:'order',clickId:'early-click',orderId:'text-order',trackingId:'text-tracking-123456'});
console.log('GHL ofetch text decoding captures order identifiers while preserving the original text response.');
