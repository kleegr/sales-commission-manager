// FLOW 4 isolated integration test (embedded PGlite; no Neon, no email provider):
// prospect proposal → send mints a hashed token + outbox row → public GET marks viewed →
// public POST approves in one transaction (client + won opportunity + ONE pending receipt for the
// salesperson) → confirmReceipt posts the earning → repeat POST is a no-op → bad/expired tokens,
// rate limiting and tenant isolation. Run: `npx tsx api/_lib/flow4-proposal.test.ts`.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {SCHEMA_SQL} from './schema.js';
import {MIGRATIONS_SQL} from './migrations.js';
import {TRACKER_SCHEMA_SQL} from './tracker-schema.js';
import {OPERATIONS_SCHEMA_SQL} from './operations-schema.js';
import {installTestDatabase} from './db.js';
import {publishPlan,assignPlan} from './tracker-people.js';
import {mutations} from '../tracker.js';
import documentsHandler from '../documents.js';
import proposalHandler,{hashToken,proposalEmail,calendarDate,issueProposalLink,proposalLink} from '../proposal.js';
import {normalizeProspect,normalizeAcceptance,receiptAmount,toMinor,proposalOverLimit,rowToDocument} from './documents-core.js';
import type {ExactPlan} from '../../src/lib/exact-commission.js';
import type {SessionUser} from './auth.js';

// A canonical proposal domain must never inherit a checkout path or credentials.
const previousProposalOrigin=process.env.PROPOSAL_PUBLIC_URL;
try {
  delete process.env.PROPOSAL_PUBLIC_URL;
  assert.equal(proposalLink('https://app.test','abc'), 'https://app.test/p/abc');
  process.env.PROPOSAL_PUBLIC_URL='https://sales.example.test/';
  assert.equal(proposalLink('https://old.test','abc'), 'https://sales.example.test/p/abc');
  for (const invalid of ['http://sales.example.test','https://sales.example.test/checkout','https://user:pass@sales.example.test','https://sales.example.test/?redirect=bad']) {
    process.env.PROPOSAL_PUBLIC_URL=invalid;
    assert.throws(()=>proposalLink('https://app.test','abc'));
  }
} finally {
  if(previousProposalOrigin===undefined) delete process.env.PROPOSAL_PUBLIC_URL;
  else process.env.PROPOSAL_PUBLIC_URL=previousProposalOrigin;
}

const {PGlite}=await import(process.env.PGLITE_TEST_MODULE||'@electric-sql/pglite');const pg=new PGlite();
// ensureSchema() sends multi-statement SQL through query(); PGlite needs exec() for that, so route param-less calls there.
const wrap=(p:any)=>({query:async(q:string,v:any[]=[])=>{if(v.length)return p.query(q,v);const out=await p.exec(q);return out[out.length-1]||{rows:[]};}});
const db:any={...wrap(pg),transaction:(f:any)=>pg.transaction((c:any)=>f(wrap(c)))};const tx=(f:any)=>db.transaction(f);
const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
const owner:SessionUser={id:'owner',tenantId:'a',tenantSlug:'a',tenantName:'Acme',name:'Owner',email:'owner@example.test',role:'owner',salespersonId:null};
const call=async(handler:any,req:any)=>{let status=200,body:any;const res:any={setHeader(){},status(n:number){status=n;return this;},json(b:any){body=b;return this;},send(b:any){body=b;return this;}};await handler({headers:{},query:{},url:'/api/x',...req},res);return{status,body};};
const asRep=(body:any,extra:any={})=>({method:'POST',url:'/api/documents',headers:{authorization:'Bearer rep-session',host:'app.test',...extra},body});
const asOwnerB=(body:any)=>({method:'POST',url:'/api/documents',headers:{authorization:'Bearer owner-b-session',host:'app.test'},body});
const pub=(req:any)=>call(proposalHandler,{url:'/api/proposal',headers:{host:'app.test'},...req});
const count=async(sql:string,v:any[]=[])=>Number((await db.query(`SELECT count(*)::int AS n FROM ${sql}`,v)).rows[0].n);
let checks=0;const check=async(name:string,fn:()=>any)=>{await fn();checks++;console.log(`✓ ${name}`);};
try{
  await pg.exec(SCHEMA_SQL);await pg.exec(MIGRATIONS_SQL);await pg.exec(MIGRATIONS_SQL);await pg.exec(TRACKER_SCHEMA_SQL);await pg.exec(OPERATIONS_SCHEMA_SQL);
  await pg.exec(`INSERT INTO tenants(id,name,slug) VALUES('a','Acme','a'),('b','Beta','b');
    INSERT INTO salespeople(id,tenant_id,name,email,role,status) VALUES('sp-alice','a','Alice Rep','alice@example.test','salesperson','active');
    INSERT INTO users(id,tenant_id,name,email,role,salesperson_id) VALUES('owner','a','Owner','owner@example.test','owner',NULL),('rep','a','Alice Rep','alice@example.test','salesperson','sp-alice'),('owner-b','b','Owner B','ownerb@example.test','owner',NULL);
    INSERT INTO sessions(id,user_id,tenant_id,expires_at) VALUES('${sha('rep-session')}','rep','a',now()+interval '1 hour'),('${sha('owner-b-session')}','owner-b','b',now()+interval '1 hour');
    INSERT INTO tracker_workspaces(tenant_id,currency,timezone,payout_terms) VALUES('a','USD','UTC','{"minorDigits":2,"separateApprover":true}');
    INSERT INTO business_profiles(tenant_id,business_name,contact_email) VALUES('a','Acme Studio','hello@acme.test');
    INSERT INTO clients(id,tenant_id,salesperson_id,company_name,contact_name,email,setup_fee_amount,monthly_subscription_amount,referrer_id,attribution_status) VALUES('cl-existing','a','sp-alice','Existing LLC','Eve Existing','eve@example.test',0,100,'sp-alice','attributed');`);
  process.env.NODE_ENV='test';installTestDatabase(db);delete process.env.RESEND_API_KEY;

  await check('pure helpers: prospect + acceptance validation, receipt amount, exact minor units, rate limit rule',()=>{
    const p=normalizeProspect({name:' Pat Prospect ',email:'PAT@Example.test',company:'Prospect Co',phone:'555',setupFee:'500',monthlySubscription:250});assert.ok(p.ok);if(p.ok){assert.equal(p.value.email,'pat@example.test');assert.equal(p.value.name,'Pat Prospect');assert.equal(p.value.setupFee,500);}
    assert.deepEqual(normalizeProspect({name:'X',email:'nope'}),{ok:false,error:'prospect_email_invalid'});assert.deepEqual(normalizeProspect({email:'a@b.co'}),{ok:false,error:'prospect_name_required'});
    assert.deepEqual(normalizeAcceptance({name:'Pat',email:'pat@example.test',signature:'Pat',agree:false}),{ok:false,error:'agreement_required'});assert.ok(normalizeAcceptance({name:'Pat',email:'pat@example.test',signature:'Pat',agree:true}).ok);
    assert.equal(receiptAmount(500,750),500);assert.equal(receiptAmount(0,100),100);assert.equal(toMinor(19.99),'1999');assert.equal(toMinor(750,0),'750');assert.equal(toMinor(0.1+0.2),'30');
    assert.equal(proposalOverLimit(0,15),true);assert.equal(proposalOverLimit(120,0),true);assert.equal(proposalOverLimit(5,3),false);assert.equal(calendarDate('Asia/Karachi',new Date('2026-01-31T22:30:00Z')),'2026-02-01');
    const mail=proposalEmail({title:'Growth plan',businessName:'Acme Studio',recipientName:'Pat',salespersonName:'Alice',link:'https://app.test/p/x',expiresAt:'2026-03-01T00:00:00.000Z'});assert.equal(mail.subject,'Acme Studio: Growth plan');assert.ok(mail.body.includes('https://app.test/p/x')&&mail.body.includes('2026-03-01'));
    const d=rowToDocument({id:'d',prospect:'{"name":"P","email":"p@x.co"}',public_token:'h',accepted_by_name:'P'});assert.equal(d.prospect?.name,'P');assert.equal(d.hasLink,true);assert.equal(d.acceptedByName,'P');assert.equal(d.createdClientId,null);
  });

  await check('catalog proposal tracks owner, product snapshots, public pricing and locked shared content',async()=>{
    await db.query("INSERT INTO sessions(id,user_id,tenant_id,expires_at) VALUES($1,'owner','a',now()+interval '1 hour')",[sha('owner-session')]);
    await db.query("INSERT INTO products(tenant_id,id,name,description,category,price_minor,currency,billing_kind,recurring_interval,status) VALUES('a','wa','WhatsApp','Managed account','Messaging',1900,'USD','recurring','month','active'),('a','setup','Setup','Configuration','Services',10000,'USD','setup','','active')");
    const own=(body:any)=>({method:'POST',headers:{authorization:'Bearer owner-session',host:'app.test'},body});
    const r=await call(documentsHandler,own({op:'create',kind:'proposal',salespersonId:'sp-alice',prospect:{name:'Catalog Client',email:'catalog@example.test'},lineItems:[{productId:'wa',qty:3,unitPriceMinor:'1900'},{productId:'setup',qty:1,unitPriceMinor:'10000'}],sections:[{id:'summary',type:'solution',title:'Summary',content:'An editable summary'}]}));
    assert.equal(r.status,201,JSON.stringify(r.body));const doc=r.body.id;
    const saved=(await db.query('SELECT * FROM documents WHERE id=$1',[doc])).rows[0];assert.equal(saved.salesperson_id,'sp-alice');assert.equal(saved.line_items[0].description,'Managed account');assert.equal(Number(saved.amount),157);
    const invalid=await call(documentsHandler,own({op:'create',kind:'proposal',salespersonId:'not-in-tenant'}));assert.equal(invalid.status,403);
    const share=await call(documentsHandler,own({op:'link',id:doc}));const first=share.body.link.split('/p/')[1];
    const view=await pub({method:'GET',query:{token:first}});assert.equal(view.status,200);assert.equal(view.body.lineItems[0].description,'Managed account');assert.deepEqual(view.body.amount,{total:157,setupFee:100,monthly:57,dueNow:157,currency:'USD'});
    assert.equal((await call(documentsHandler,own({op:'update_document',id:doc,title:'Silent edit'}))).status,409);
    assert.equal((await call(documentsHandler,own({op:'section_update',id:doc,scope:'document',sectionId:'summary',content:'Silent edit'}))).status,409);
    assert.equal((await call(documentsHandler,own({op:'set_status',id:doc,status:'signed'}))).body.error,'automatic_status');
    assert.equal((await call(documentsHandler,own({op:'set_status',id:doc,status:'canceled'}))).status,200);
    assert.equal((await pub({method:'GET',query:{token:first}})).status,404);
    await call(documentsHandler,own({op:'set_status',id:doc,status:'draft'}));
    assert.equal((await call(documentsHandler,own({op:'update_document',id:doc,title:'Revised draft'}))).status,200);
    // Keep the original test's document counts independent of this draft.
    await db.query('DELETE FROM documents WHERE id=$1',[doc]);
  });

  let docId='',token='';
  await check('salesperson creates a PROSPECT proposal (no client yet); amount = setup + monthly',async()=>{
    const r=await call(documentsHandler,asRep({op:'create',kind:'proposal',prospect:{name:'Pat Prospect',email:'pat@example.test',company:'Prospect Co',phone:'555-0100',setupFee:500,monthlySubscription:250},title:'Growth plan'}));
    assert.equal(r.status,201,JSON.stringify(r.body));docId=r.body.id;const row=(await db.query('SELECT * FROM documents WHERE id=$1',[docId])).rows[0];
    assert.equal(row.client_id,null);assert.equal(row.salesperson_id,'sp-alice');assert.equal(row.prospect.company,'Prospect Co');assert.equal(Number(row.amount),750);assert.equal(row.status,'draft');
    assert.ok(JSON.stringify(row.sections).includes('Prospect Co'),'merge fields resolve from the prospect');
    assert.equal((await call(documentsHandler,asRep({op:'create',kind:'proposal',prospect:{name:'No Email'}}))).status,400);
  });
  await check('send mints a 256-bit token (only its sha256 is stored), sets sent/sent_to and queues the email in the outbox',async()=>{
    const r=await call(documentsHandler,asRep({op:'send',id:docId}));assert.equal(r.status,200,JSON.stringify(r.body));
    assert.ok(r.body.link.startsWith('https://app.test/p/'));token=r.body.link.split('/p/')[1];assert.equal(token.length,43);assert.equal(r.body.to,'pat@example.test');assert.equal(r.body.email,'queued');assert.equal(r.body.emailError,'email_not_configured');
    const row=(await db.query('SELECT * FROM documents WHERE id=$1',[docId])).rows[0];assert.equal(row.public_token,hashToken(token));assert.notEqual(row.public_token,token);assert.equal(row.status,'sent');assert.equal(row.sent_to,'pat@example.test');assert.ok(row.sent_at&&row.token_expires_at);
    const mail=(await db.query('SELECT * FROM tracker_email_outbox WHERE tenant_id=$1',['a'])).rows;assert.equal(mail.length,1);assert.equal(mail[0].recipient,'pat@example.test');assert.equal(mail[0].status,'pending');assert.ok(mail[0].body.includes(r.body.link));
  });
  await check('invalid proposal domain leaves the existing approval link usable',async()=>{
    const before=(await db.query('SELECT public_token,token_expires_at,status FROM documents WHERE id=$1',[docId])).rows[0];
    const previous=process.env.PROPOSAL_PUBLIC_URL;
    try {
      process.env.PROPOSAL_PUBLIC_URL='https://sales.example.test/proposal';
      const r=await call(documentsHandler,asRep({op:'link',id:docId}));
      assert.equal(r.status,400);assert.equal(r.body.error,'proposal_domain_invalid');
      const after=(await db.query('SELECT public_token,token_expires_at,status FROM documents WHERE id=$1',[docId])).rows[0];
      assert.deepEqual(after,before);
    } finally { if(previous===undefined)delete process.env.PROPOSAL_PUBLIC_URL;else process.env.PROPOSAL_PUBLIC_URL=previous; }
  });
  await check('public GET renders the merged document, branding and amount summary, and marks it viewed exactly once',async()=>{
    const r=await pub({method:'GET',query:{token}});assert.equal(r.status,200,JSON.stringify(r.body));
    assert.equal(r.body.status,'viewed');assert.equal(r.body.title,'Growth plan');assert.equal(r.body.branding.businessName,'Acme Studio');assert.deepEqual(r.body.amount,{total:750,setupFee:500,monthly:250,dueNow:500,currency:'USD'});assert.equal(r.body.recipient.company,'Prospect Co');assert.equal(r.body.salesperson.name,'Alice Rep');assert.equal(r.body.accepted,null);assert.ok(Array.isArray(r.body.sections)&&r.body.sections.length>3);assert.equal('id' in r.body,false);
    const row=(await db.query('SELECT status,viewed_at FROM documents WHERE id=$1',[docId])).rows[0];assert.equal(row.status,'viewed');assert.ok(row.viewed_at);
    const again=await pub({method:'GET',query:{token}});assert.equal(again.body.status,'viewed');assert.equal((await db.query('SELECT viewed_at FROM documents WHERE id=$1',[docId])).rows[0].viewed_at.toString(),row.viewed_at.toString());
  });
  await check('public POST validates the form and never trusts ids from the body',async()=>{
    assert.equal((await pub({method:'POST',body:{token,name:'Pat Prospect',email:'pat@example.test',signature:'Pat Prospect'}})).body.error,'agreement_required');
    assert.equal((await pub({method:'POST',body:{token,name:'P',email:'pat@example.test',signature:'Pat',agree:true}})).body.error,'name_required');
    assert.equal((await pub({method:'POST',body:{token:'x'.repeat(43),name:'Pat Prospect',email:'pat@example.test',signature:'Pat',agree:true}})).status,404);
    assert.equal((await pub({method:'POST',headers:{host:'app.test',origin:'https://evil.test'},body:{token,name:'Pat Prospect',email:'pat@example.test',signature:'Pat',agree:true}})).status,403);
    assert.equal((await db.query('SELECT status FROM documents WHERE id=$1',[docId])).rows[0].status,'viewed');
  });
  await check('approval creates the client from the prospect, a won opportunity and ONE pending receipt for the salesperson — all in one transaction',async()=>{
    const r=await pub({method:'POST',body:{token,name:'Pat Prospect',email:'pat@example.test',signature:'Pat Prospect',agree:true,tenantId:'b',clientId:'cl-existing'}});assert.equal(r.status,200,JSON.stringify(r.body));
    assert.equal(r.body.accepted.name,'Pat Prospect');assert.equal(r.body.alreadyAccepted,false);assert.equal('clientId' in r.body,false);
    const d=(await db.query('SELECT * FROM documents WHERE id=$1',[docId])).rows[0];assert.equal(d.status,'signed');assert.equal(d.accepted_by_name,'Pat Prospect');assert.equal(d.accepted_email,'pat@example.test');assert.equal(d.signature_data,'Pat Prospect');assert.ok(d.signed_at&&d.accepted_at);assert.ok(d.created_client_id&&d.created_opportunity_id);assert.equal(d.receipt_event_key,`proposal:${docId}`);
    const c=(await db.query('SELECT * FROM clients WHERE id=$1',[d.created_client_id])).rows[0];assert.equal(c.tenant_id,'a');assert.equal(c.company_name,'Prospect Co');assert.equal(c.email,'pat@example.test');assert.equal(c.salesperson_id,'sp-alice');assert.equal(c.referrer_id,'sp-alice');assert.equal(c.original_source,'proposal');assert.equal(c.attribution_status,'attributed');assert.equal(Number(c.setup_fee_amount),500);assert.equal(Number(c.monthly_subscription_amount),250);
    const o=(await db.query('SELECT * FROM opportunities WHERE id=$1',[d.created_opportunity_id])).rows[0];assert.equal(o.status,'won');assert.equal(o.client_id,c.id);assert.equal(o.owner_id,'sp-alice');assert.equal(String(o.value_minor),'75000');assert.equal(o.currency,'USD');assert.ok(o.won_at);
    const p=(await db.query('SELECT * FROM payments WHERE tenant_id=$1 AND event_key=$2',['a',`proposal:${docId}`])).rows;assert.equal(p.length,1);assert.equal(p[0].receipt_status,'pending');assert.equal(String(p[0].amount_minor),'50000');assert.equal(p[0].client_id,c.id);assert.equal(p[0].opportunity_id,o.id);assert.equal(p[0].salesperson_id,'sp-alice');
    assert.equal(await count('commission_ledger WHERE payment_id=$1',[p[0].id]),0,'no earning until an admin confirms the cash');assert.equal(await count("audit_logs WHERE action='proposal_accepted'"),1);
  });
  await check('a second approval on the same link is an idempotent no-op (no duplicate client / opportunity / receipt)',async()=>{
    const before=[await count('clients'),await count('opportunities'),await count('payments')];const r=await pub({method:'POST',body:{token,name:'Someone Else',email:'else@example.test',signature:'Someone Else',agree:true}});
    assert.equal(r.status,200);assert.equal(r.body.alreadyAccepted,true);assert.equal(r.body.accepted.name,'Pat Prospect');assert.deepEqual([await count('clients'),await count('opportunities'),await count('payments')],before);assert.equal((await db.query('SELECT accepted_by_name FROM documents WHERE id=$1',[docId])).rows[0].accepted_by_name,'Pat Prospect');
    const view=await pub({method:'GET',query:{token}});assert.equal(view.body.accepted.name,'Pat Prospect');assert.equal(view.body.status,'signed');
  });
  await check('confirming the pending receipt (existing confirmReceipt flow) posts the salesperson earning exactly once',async()=>{
    const plan:ExactPlan={currency:'USD',minorDigits:2,rules:[{id:'rate',name:'Setup fee share',event:'payment',kind:'percent',value:'1000',beneficiary:'referrer',base:'gross',chargeFrom:1,holdDays:0,group:'standard',stacking:'exclusive',priority:1}]};
    const v=await tx((c:any)=>publishPlan(c,owner,{name:'Standard',config:plan,effectiveFrom:'2020-01-01'}));await tx((c:any)=>assignPlan(c,owner,{salespersonId:'sp-alice',versionId:v.id,effectiveFrom:'2020-01-01'}));
    const pay=(await db.query('SELECT id FROM payments WHERE event_key=$1',[`proposal:${docId}`])).rows[0];await tx((c:any)=>mutations.confirmReceipt(c,owner,{id:pay.id,reason:'Bank statement shows the setup fee'}));
    const earnings=(await db.query('SELECT * FROM commission_ledger WHERE payment_id=$1',[pay.id])).rows;assert.equal(earnings.length,1);assert.equal(earnings[0].salesperson_id,'sp-alice');assert.equal(String(earnings[0].amount_minor),'5000');assert.equal(earnings[0].status,'pending');
    assert.equal((await tx((c:any)=>mutations.confirmReceipt(c,owner,{id:pay.id,reason:'again'}))).duplicate,true);assert.equal(await count('commission_ledger WHERE payment_id=$1',[pay.id]),1);
  });
  await check('invalid, malformed and expired tokens are rejected; a signed document cannot be re-shared',async()=>{
    assert.equal((await pub({method:'GET',query:{token:'nope'}})).status,404);assert.equal((await pub({method:'GET',query:{token:'A'.repeat(43)}})).body.error,'invalid_token');
    await db.query("UPDATE documents SET token_expires_at=now()-interval '1 day' WHERE id=$1",[docId]);const r=await pub({method:'GET',query:{token}});assert.equal(r.status,410);assert.equal(r.body.error,'link_expired');await db.query("UPDATE documents SET token_expires_at=now()+interval '30 days' WHERE id=$1",[docId]);
    assert.equal((await call(documentsHandler,asRep({op:'send',id:docId}))).body.error,'invalid_transition');
  });
  await check('rate limiting: repeated failures from one IP are throttled (fail-open shape, per-IP window)',async()=>{
    const ip={'x-forwarded-for':'203.0.113.9'};for(let i=0;i<15;i++)await pub({method:'GET',query:{token:'B'.repeat(43)},headers:{host:'app.test',...ip}});
    assert.equal((await pub({method:'GET',query:{token},headers:{host:'app.test',...ip}})).status,429);assert.equal((await pub({method:'GET',query:{token},headers:{host:'app.test','x-forwarded-for':'198.51.100.7'}})).status,200);
  });
  await check('tenant isolation: another tenant cannot send, list or see the created client; new links preserve existing unexpired links',async()=>{
    assert.equal((await call(documentsHandler,asOwnerB({op:'send',id:docId}))).status,404);assert.equal((await call(documentsHandler,asOwnerB({op:'link',id:docId}))).status,404);
    const list=await call(documentsHandler,{method:'GET',url:'/api/documents',headers:{authorization:'Bearer owner-b-session'},query:{}});assert.equal(list.body.documents.length,0);assert.equal(await count("clients WHERE tenant_id='b'"),0);
    const mine=await call(documentsHandler,{method:'GET',url:'/api/documents',headers:{authorization:'Bearer rep-session'},query:{}});const row=mine.body.documents.find((x:any)=>x.id===docId);assert.equal(row.acceptedByName,'Pat Prospect');assert.equal(row.hasLink,true);assert.ok(row.createdClientId&&row.receiptEventKey);assert.equal(row.prospect.email,'pat@example.test');
    const c=await call(documentsHandler,asRep({op:'create',kind:'proposal',clientId:'cl-existing'}));const id2=c.body.id;const l1=await call(documentsHandler,asRep({op:'link',id:id2}));assert.equal(l1.status,200);assert.equal(l1.body.email,'unavailable');const t1=l1.body.link.split('/p/')[1];
    assert.equal((await db.query('SELECT status FROM documents WHERE id=$1',[id2])).rows[0].status,'sent');const l2=await call(documentsHandler,asRep({op:'link',id:id2}));const t2=l2.body.link.split('/p/')[1];assert.notEqual(t1,t2);
    assert.equal((await pub({method:'GET',query:{token:t1}})).status,200,'previously shared token remains usable');assert.equal((await pub({method:'GET',query:{token:t2}})).status,200);
    await assert.rejects(tx((c:any)=>issueProposalLink(c,'b',id2)),{code:'not_found'});
    const a=await pub({method:'POST',body:{token:t2,name:'Eve Existing',email:'eve@example.test',signature:'Eve Existing',agree:true}});assert.equal(a.status,200,JSON.stringify(a.body));
    const d=(await db.query('SELECT * FROM documents WHERE id=$1',[id2])).rows[0];assert.equal(d.created_client_id,null,'existing client is reused, not duplicated');assert.ok(d.created_opportunity_id);assert.equal(await count("clients WHERE tenant_id='a'"),2);
    const p=(await db.query('SELECT amount_minor,client_id FROM payments WHERE event_key=$1',[`proposal:${id2}`])).rows[0];assert.equal(String(p.amount_minor),'10000','no setup fee -> the full amount is expected');assert.equal(p.client_id,'cl-existing');
  });
  await check('a zero-amount prospect still becomes a client + won opportunity with no receipt; approval survives without a tracker workspace',async()=>{
    const c=await call(documentsHandler,asRep({op:'create',kind:'contract',prospect:{name:'Zed Zero',email:'zed@example.test'}}));const id3=c.body.id;const t=(await call(documentsHandler,asRep({op:'send',id:id3,to:'other@example.test'}))).body.link.split('/p/')[1];
    assert.equal((await db.query('SELECT sent_to FROM documents WHERE id=$1',[id3])).rows[0].sent_to,'other@example.test');
    const a=await pub({method:'POST',body:{token:t,name:'Zed Zero',email:'zed@example.test',signature:'Zed Zero',agree:true}});assert.equal(a.status,200,JSON.stringify(a.body));const d=(await db.query('SELECT * FROM documents WHERE id=$1',[id3])).rows[0];
    assert.ok(d.created_client_id&&d.created_opportunity_id);assert.equal(d.receipt_event_key,null);assert.equal(await count('payments WHERE event_key=$1',[`proposal:${id3}`]),0);
    await db.query("DELETE FROM tracker_workspaces WHERE tenant_id='a'");const c2=await call(documentsHandler,asRep({op:'create',kind:'proposal',prospect:{name:'Wanda Workspaceless',email:'wanda@example.test',setupFee:10}}));const t2=(await call(documentsHandler,asRep({op:'link',id:c2.body.id}))).body.link.split('/p/')[1];
    const a2=await pub({method:'POST',body:{token:t2,name:'Wanda Workspaceless',email:'wanda@example.test',signature:'W W',agree:true}});assert.equal(a2.status,200);const d2=(await db.query('SELECT * FROM documents WHERE id=$1',[c2.body.id])).rows[0];assert.equal(d2.status,'signed');assert.ok(d2.created_client_id);assert.equal(d2.created_opportunity_id,null);assert.equal(d2.receipt_event_key,null);
  });
  await check('a finance failure rolls back only the savepoint: the approval + client persist and the document records no receipt',async()=>{
    await db.query("INSERT INTO tracker_workspaces(tenant_id,currency,timezone,payout_terms) VALUES('a','USD','UTC','{\"minorDigits\":2}')");await db.query('ALTER TABLE opportunities RENAME TO opportunities_offline');
    try{const c=await call(documentsHandler,asRep({op:'create',kind:'proposal',prospect:{name:'Fay Failure',email:'fay@example.test',setupFee:40}}));const t=(await call(documentsHandler,asRep({op:'link',id:c.body.id}))).body.link.split('/p/')[1];
      const a=await pub({method:'POST',body:{token:t,name:'Fay Failure',email:'fay@example.test',signature:'Fay',agree:true}});assert.equal(a.status,200,JSON.stringify(a.body));const d=(await db.query('SELECT * FROM documents WHERE id=$1',[c.body.id])).rows[0];
      assert.equal(d.status,'signed');assert.ok(d.created_client_id);assert.equal(d.created_opportunity_id,null);assert.equal(d.receipt_event_key,null);assert.equal(await count('payments WHERE event_key=$1',[`proposal:${c.body.id}`]),0);
      const log=(await db.query("SELECT after FROM audit_logs WHERE action='proposal_accepted' AND entity_id=$1",[c.body.id])).rows[0].after;assert.equal(log.receipt,'failed');
    }finally{await db.query('ALTER TABLE opportunities_offline RENAME TO opportunities');}
  });
  console.log(`${checks} FLOW 4 proposal scenarios passed.`);
}finally{await pg.close();}
