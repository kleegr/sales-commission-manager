import vm from 'node:vm';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const code=await readFile(new URL('../public/affiliate.js',import.meta.url),'utf8');
const events=[],saved=new Map();
const nativeFetch=async(url,init)=>{if(String(url).includes('/api/affiliate-track')){const b=JSON.parse(init.body);events.push(b);return Response.json(b.action==='visit'?{clickId:'random-click',expiresAt:Date.now()+100000}:b.action==='order'?{status:'test_calculated'}:{ok:true});}return Response.json({order:{_id:'order-test',trackingId:'order-tracking-123456'}});};
class XHR{open(){}send(){}addEventListener(){}}
const window={fetch:nativeFetch};const context={window,document:{currentScript:{src:'https://tracker.example/affiliate.js'},cookie:''},location:{href:'https://example.com/checkout?st_ref=affiliate-code',search:'?st_ref=affiliate-code'},localStorage:{getItem:k=>saved.get(k),setItem:(k,v)=>saved.set(k,v)},XMLHttpRequest:XHR,URL,URLSearchParams,Date,JSON,Promise,decodeURIComponent,setTimeout};
vm.runInNewContext(code,context);await new Promise(r=>setTimeout(r,10));
const result=await window.fetch('https://services.leadconnectorhq.com/payments/orders',{method:'POST'});assert.equal(result.status,200);await new Promise(r=>setTimeout(r,10));
assert.deepEqual(events.map(e=>e.action),['visit','ready','order']);assert.deepEqual(events[2],{action:'order',clickId:'random-click',orderId:'order-test',trackingId:'order-tracking-123456'});
await window.fetch('https://services.leadconnectorhq.com/payments/stripe/verify',{method:'POST',body:'card details not observed'});await new Promise(r=>setTimeout(r,10));assert.equal(events.length,3);
await window.fetch('https://attacker.example/payments/orders',{method:'POST'});await new Promise(r=>setTimeout(r,10));assert.equal(events.length,3);
vm.runInNewContext(code,context);await new Promise(r=>setTimeout(r,10));assert.equal(events.length,3);
console.log('Affiliate bridge preserves checkout responses, captures only scoped order identifiers, ignores card/payment and foreign requests, and installs once.');
