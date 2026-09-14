import assert from 'node:assert/strict';
import {SCHEMA_SQL} from './schema.js';
import {MIGRATIONS_SQL} from './migrations.js';
import {TRACKER_SCHEMA_SQL} from './tracker-schema.js';
import {EXPERIENCE_SCHEMA_SQL} from './tracker-experience-schema.js';
import {OPERATIONS_SCHEMA_SQL} from './operations-schema.js';
import {enroll,linkSalesman,saveParticipant,publishPlan,assignPlan} from './tracker-people.js';
import {createLead} from './tracker-attribution.js';
import {listResource} from './tracker-read.js';
import {approveImport,autoImportEvent,isWonOpportunity,normalizeWebhookRow,pipelinePolicy,queueTrackerEvent} from './tracker-sync.js';
import {reviewEvent} from './operations.js';
import {persistTeam} from './directory-sync.js';
import {mutations} from '../tracker.js';
import type {SessionUser} from './auth.js';
import type {ExactPlan} from '../../src/lib/exact-commission.js';

// FLOW 2 (salespeople are users or outside people) and FLOW 3 (commission from actual pipeline deals).
// Isolated embedded Postgres: no Neon, no GHL, no HTTP. Webhook bodies go through the same normaliser the receiver uses.
const moduleName=process.env.PGLITE_TEST_MODULE||'@electric-sql/pglite';
const {PGlite}=await import(moduleName);const pg=new PGlite();
const db={query:async(sql:string,params:any[]=[])=>pg.query(sql,params)};
const tx=(fn:(c:any)=>Promise<any>)=>pg.transaction((c:any)=>fn({query:(s:string,p:any[]=[])=>c.query(s,p)}));
const database={...db,transaction:tx} as any;
const u:SessionUser={id:'owner',tenantId:'a',tenantSlug:'a',tenantName:'A',name:'Owner',email:'owner@example.test',role:'owner',salespersonId:null};
const rep={...u,id:'rep',role:'salesperson' as const,salespersonId:'nobody'};
const approve=(id:string,extra:any={})=>tx(c=>approveImport(c,u,{id,confirmMapping:true,amountUnits:'major',reason:'Isolated verified mapping',...extra}));
const count=async(sql:string,params:any[]=[])=>Number((await db.query(`SELECT count(*)::int AS n ${sql}`,params)).rows[0].n);
let checks=0;async function check(name:string,fn:()=>any){await fn();checks++;console.log(`✓ ${name}`);}
try{
  await pg.exec(SCHEMA_SQL);await pg.exec(MIGRATIONS_SQL);
  await pg.exec("INSERT INTO tenants(id,name,slug) VALUES('a','A','a'),('b','B','b'); INSERT INTO users(id,tenant_id,name,email,role) VALUES('owner','a','Owner','owner@example.test','owner');");
  await pg.exec(TRACKER_SCHEMA_SQL);await pg.exec(TRACKER_SCHEMA_SQL);await pg.exec(EXPERIENCE_SCHEMA_SQL);
  await pg.exec("INSERT INTO tracker_workspaces(tenant_id,currency) VALUES('a','USD'),('b','USD')");
  await check('pipeline policy column is additive, repeatable and defaults to manual review with pending receipts',async()=>{
    const stored=(await db.query("SELECT pipeline_policy FROM tracker_workspaces WHERE tenant_id='a'")).rows[0].pipeline_policy;
    assert.deepEqual(pipelinePolicy(stored),{pipelineId:null,wonStageIds:[],treatStatusWonAsWon:true,auto:false,receipt:'pending'});
    assert.deepEqual(pipelinePolicy({pipelineId:' p1 ',wonStageIds:'s1, s2,,s1',treatStatusWonAsWon:'false',auto:'true',receipt:'confirmed'}),{pipelineId:'p1',wonStageIds:['s1','s2'],treatStatusWonAsWon:false,auto:true,receipt:'confirmed'});
    const policy=pipelinePolicy({pipelineId:'p1',wonStageIds:['won']});
    assert.equal(isWonOpportunity(policy,{pipelineId:'p1',status:'won'}),true);assert.equal(isWonOpportunity(policy,{pipelineId:'p1',status:'open',stageId:'won'}),true);assert.equal(isWonOpportunity(policy,{pipelineId:'other',status:'won',stageId:'won'}),false);assert.equal(isWonOpportunity(pipelinePolicy({treatStatusWonAsWon:false}),{status:'won'}),false);
  });
  // Directory users synced from the sub-account, plus one existing app login that carries the provider identity.
  const users=[{id:'u-alice',name:'Alice Login',email:'alice@example.test',phone:'',role:'admin'},{id:'u-bob',name:'Bob Seller',email:'bob@example.test',phone:'+1555',role:'user'}];
  await persistTeam('a',users,tx);await persistTeam('b',users,tx);
  await db.query("INSERT INTO users(id,tenant_id,name,email,role,kleegr_user_id) VALUES('login-alice','a','Alice Login','alice@example.test','salesperson','u-alice')");
  const outside=(await tx(c=>saveParticipant(c,u,{name:'Outside Seller',email:'outside@example.test',role:'affiliate',status:'active'}))).id;
  const other=(await tx(c=>saveParticipant(c,u,{name:'Other Seller',email:'other@example.test',role:'salesperson',status:'active'}))).id;
  await check('FLOW 2: link an external salesman to a directory user, refuse a second claim, unlink back to external',async()=>{
    await assert.rejects(tx(c=>linkSalesman(c,rep,{id:outside,externalId:'u-alice'})),{code:'forbidden'});
    await assert.rejects(tx(c=>linkSalesman(c,{...u,tenantId:'b'},{id:outside,externalId:'u-alice'})),{code:'not_found'});
    await assert.rejects(tx(c=>linkSalesman(c,u,{id:outside,externalId:'not-in-directory'})),{code:'not_available'});
    const linked=await tx(c=>linkSalesman(c,u,{id:outside,externalId:'u-alice'}));assert.equal(linked.linked,true);
    const sp=(await db.query('SELECT ghl_user_id,ghl_role,ghl_active,ghl_synced_at,name,email FROM salespeople WHERE id=$1',[outside])).rows[0];
    assert.equal(sp.ghl_user_id,'u-alice');assert.equal(sp.ghl_role,'admin');assert.equal(sp.ghl_active,true);assert.ok(sp.ghl_synced_at);assert.equal(sp.name,'Outside Seller');
    assert.equal((await db.query("SELECT salesperson_id FROM users WHERE id='login-alice'")).rows[0].salesperson_id,outside);
    assert.equal((await tx(c=>linkSalesman(c,u,{id:outside,externalId:'u-alice'}))).duplicate,true);
    await assert.rejects(tx(c=>linkSalesman(c,u,{id:other,externalId:'u-alice'})),{code:'user_already_linked'});
    assert.equal((await listResource(db,u,'directory',{id:'u-alice'})).rows[0].participant_id,outside);
    assert.equal((await listResource(db,u,'people',{id:outside})).total,1);
    const unlinked=await tx(c=>linkSalesman(c,u,{id:outside,externalId:null}));assert.equal(unlinked.linked,false);
    const after=(await db.query('SELECT ghl_user_id,ghl_role,ghl_active,ghl_synced_at FROM salespeople WHERE id=$1',[outside])).rows[0];
    assert.deepEqual(after,{ghl_user_id:null,ghl_role:null,ghl_active:null,ghl_synced_at:null});
    assert.equal((await db.query("SELECT salesperson_id FROM users WHERE id='login-alice'")).rows[0].salesperson_id,null);
    assert.equal((await listResource(db,u,'directory',{id:'u-alice'})).rows[0].participant_id,null);
    assert.equal((await tx(c=>linkSalesman(c,u,{id:outside,externalId:null}))).duplicate,true);
    assert.equal(await count("FROM audit_logs WHERE entity_id=$1 AND action IN('login_linked','login_unlinked')",[outside]),2);
    // The other salesman can now take the user; relinking moves the login back-reference with it.
    await tx(c=>linkSalesman(c,u,{id:other,externalId:'u-alice'}));assert.equal((await db.query("SELECT salesperson_id FROM users WHERE id='login-alice'")).rows[0].salesperson_id,other);
    await tx(c=>linkSalesman(c,u,{id:other,externalId:null}));
  });
  let bob='';
  await check('FLOW 2: Import from Users adopts the external salesman with the same email instead of duplicating',async()=>{
    const external=(await tx(c=>saveParticipant(c,u,{name:'Bob External',email:'BOB@example.test',role:'salesperson',status:'active'}))).id;
    const before=(await listResource(db,u,'directory',{id:'u-bob'})).rows[0];assert.equal(before.participant_id,external);assert.equal(before.participant_match,'email');
    const enrolled=await tx(c=>enroll(c,u,{externalIds:['u-bob'],role:'salesperson'}));assert.deepEqual(enrolled.ids,[external]);bob=external;
    assert.equal(await count("FROM salespeople WHERE tenant_id='a' AND lower(trim(email))='bob@example.test'"),1);
    const sp=(await db.query('SELECT name,phone,ghl_user_id,ghl_active,enrolled_by FROM salespeople WHERE id=$1',[external])).rows[0];
    assert.equal(sp.ghl_user_id,'u-bob');assert.equal(sp.name,'Bob Seller');assert.equal(sp.phone,'+1555');assert.equal(sp.ghl_active,true);assert.equal(sp.enrolled_by,'owner');
    const after=(await listResource(db,u,'directory',{id:'u-bob'})).rows[0];assert.equal(after.participant_id,external);assert.equal(after.participant_match,'user');
    assert.deepEqual((await tx(c=>enroll(c,u,{externalIds:['u-bob'],role:'affiliate'}))).ids,[external]);
    assert.equal(await count("FROM audit_logs WHERE entity_id=$1 AND action='enrollment_adopted'",[external]),1);
    // Same email in another workspace is a different person: a fresh record there, nothing borrowed across tenants.
    const foreign=(await tx(c=>enroll(c,{...u,tenantId:'b'},{externalIds:['u-bob'],role:'salesperson'}))).ids[0];assert.notEqual(foreign,external);
  });
  const lead=(await tx(c=>createLead(c,u,{name:'Deal Contact',email:'deal@example.test',source:'ghl',date:'2026-02-01'}))).id;
  await db.query("UPDATE clients SET ghl_contact_id='contact-1' WHERE id=$1",[lead]);
  const opportunity=(patch:any={})=>({id:'opp-1',contactId:'contact-1',name:'Big deal',status:'open',monetaryValue:1500,pipelineId:'pipe-1',pipelineStageId:'stage-new',assignedTo:'u-bob',updatedAt:'2026-03-01T00:00:00Z',locationId:'loc',...patch});
  await check('FLOW 3: opportunity webhooks normalise to the sync row shape and approveImport upserts the opportunity',async()=>{
    assert.equal(normalizeWebhookRow('opportunity.created',{name:'no id'}),null);assert.equal(normalizeWebhookRow('app.installed',{id:'x'}),null);
    const n=normalizeWebhookRow('opportunity.created',opportunity())!;assert.equal(n.resource,'opportunities');
    assert.deepEqual(n.row,{externalId:'opp-1',contactId:'contact-1',name:'Big deal',status:'open',monetaryValue:'1500',pipelineId:'pipe-1',stageId:'stage-new',assignedTo:'u-bob',updatedAt:'2026-03-01T00:00:00Z'});
    const review=await tx(c=>queueTrackerEvent(c,'a','opportunities',n.row));assert.equal(review.status,'pending');
    assert.equal((await tx(c=>queueTrackerEvent(c,'a','opportunities',n.row))).id,review.id);assert.equal(await count("FROM import_reviews WHERE tenant_id='a'"),1);
    await assert.rejects(approve(review.id,{confirmMapping:false}),{code:'mapping_required'});
    const result=await approve(review.id);assert.equal(result.commission,null);
    const opp=(await db.query("SELECT * FROM opportunities WHERE tenant_id='a' AND external_id='opp-1'")).rows[0];
    assert.equal(opp.client_id,lead);assert.equal(opp.owner_id,bob);assert.equal(String(opp.value_minor),'150000');assert.equal(opp.status,'open');assert.equal(opp.source,'ghl');assert.equal(opp.won_at,null);
    assert.equal(await count("FROM payments WHERE tenant_id='a'"),0);
    // A stale redelivery cannot overwrite the newer staged payload; an identical one keeps the approved status.
    await tx(c=>queueTrackerEvent(c,'a','opportunities',{...n.row,name:'Stale',updatedAt:'2026-01-01T00:00:00Z'}));
    const stored=(await db.query('SELECT payload,status FROM import_reviews WHERE id=$1',[review.id])).rows[0];assert.equal(stored.payload.name,'Big deal');assert.equal(stored.status,'approved');
  });
  const plan:ExactPlan={currency:'USD',minorDigits:2,rules:[{id:'owner-rate',name:'Owner deal commission',event:'payment',kind:'percent',value:'1000',beneficiary:'owner',base:'gross',chargeFrom:1,holdDays:0,group:'deal',stacking:'exclusive',priority:1}]};
  const version=await tx(c=>publishPlan(c,u,{name:'Deals',config:plan,effectiveFrom:'2026-01-01'}));await tx(c=>assignPlan(c,u,{salespersonId:bob,versionId:version.id,effectiveFrom:'2026-01-01'}));
  await check('FLOW 3: the pipeline policy is admin-only, validated and stored on the workspace',async()=>{
    await assert.rejects(tx(c=>mutations.pipelinePolicy(c,rep,{auto:true})),{code:'forbidden'});
    await assert.rejects(tx(c=>mutations.pipelinePolicy(c,u,{auto:true,treatStatusWonAsWon:false,wonStageIds:[]})),{code:'invalid_policy'});
    const saved=await tx(c=>mutations.pipelinePolicy(c,u,{pipelineId:'pipe-1',wonStageIds:['stage-won'],treatStatusWonAsWon:true,auto:false,receipt:'confirmed'}));
    assert.deepEqual(saved.policy,{pipelineId:'pipe-1',wonStageIds:['stage-won'],treatStatusWonAsWon:true,auto:false,receipt:'confirmed'});
    assert.deepEqual((await db.query("SELECT pipeline_policy FROM tracker_workspaces WHERE tenant_id='a'")).rows[0].pipeline_policy,saved.policy);
    assert.deepEqual(pipelinePolicy((await db.query("SELECT pipeline_policy FROM tracker_workspaces WHERE tenant_id='b'")).rows[0].pipeline_policy).auto,false);
  });
  await check('FLOW 3: a won opportunity with an owner posts exactly one receipt and ledger set; later updates and re-approval never double-post',async()=>{
    const won=normalizeWebhookRow('opportunity.updated',opportunity({pipelineStageId:'stage-won',updatedAt:'2026-03-02T00:00:00Z'}))!;
    const review=await tx(c=>queueTrackerEvent(c,'a','opportunities',won.row));assert.equal(review.status,'pending');
    const result=await approve(review.id);assert.equal(result.commission,'confirmed');
    const payment=(await db.query("SELECT * FROM payments WHERE tenant_id='a' AND event_key='opportunity:opp-1'")).rows;assert.equal(payment.length,1);
    const opp=(await db.query("SELECT * FROM opportunities WHERE tenant_id='a' AND external_id='opp-1'")).rows[0];
    assert.equal(payment[0].client_id,lead);assert.equal(payment[0].opportunity_id,opp.id);assert.equal(String(payment[0].amount_minor),'150000');assert.equal(payment[0].receipt_status,'confirmed');assert.equal(payment[0].payment_date,'2026-03-02');assert.equal(payment[0].source,'ghl');assert.equal(payment[0].notes,'Won opportunity');
    assert.equal(new Date(opp.won_at).toISOString(),'2026-03-02T00:00:00.000Z');assert.equal(opp.closer_id,bob);
    assert.equal((await db.query('SELECT salesperson_id FROM clients WHERE id=$1',[lead])).rows[0].salesperson_id,bob);
    const ledger=(await db.query("SELECT * FROM commission_ledger WHERE tenant_id='a' AND payment_id=$1",[payment[0].id])).rows;assert.equal(ledger.length,1);assert.equal(ledger[0].salesperson_id,bob);assert.equal(String(ledger[0].amount_minor),'15000');assert.equal(ledger[0].opportunity_id,opp.id);
    assert.equal((await approve(review.id)).duplicate,true);
    // Provider keeps updating the won deal (new value, new timestamp): the mirror updates, the receipt does not move.
    const again=normalizeWebhookRow('opportunity.updated',opportunity({pipelineStageId:'stage-won',status:'won',monetaryValue:2000,updatedAt:'2026-03-03T00:00:00Z'}))!;
    const reopened=await tx(c=>queueTrackerEvent(c,'a','opportunities',again.row));assert.equal(reopened.id,review.id);assert.equal(reopened.status,'pending');
    assert.equal((await approve(review.id)).commission,'already_posted');
    assert.equal(await count("FROM payments WHERE tenant_id='a' AND event_key='opportunity:opp-1'"),1);assert.equal(await count("FROM commission_ledger WHERE tenant_id='a' AND payment_id=$1",[payment[0].id]),1);
    assert.equal(String((await db.query("SELECT value_minor,status FROM opportunities WHERE external_id='opp-1'")).rows[0].value_minor),'200000');
    assert.equal(String((await db.query("SELECT amount_minor FROM payments WHERE event_key='opportunity:opp-1'")).rows[0].amount_minor),'150000');
    // Won deals outside the configured pipeline, or without an owner, import without posting anything.
    const elsewhere=normalizeWebhookRow('opportunity.updated',opportunity({id:'opp-other',pipelineId:'pipe-2',status:'won',updatedAt:'2026-03-03T00:00:00Z'}))!;
    assert.equal((await approve((await tx(c=>queueTrackerEvent(c,'a','opportunities',elsewhere.row))).id)).commission,null);
    const unowned=normalizeWebhookRow('opportunity.updated',opportunity({id:'opp-unowned',assignedTo:null,status:'won',updatedAt:'2026-03-03T00:00:00Z'}))!;
    assert.equal((await approve((await tx(c=>queueTrackerEvent(c,'a','opportunities',unowned.row))).id)).commission,'owner_required');
    assert.equal(await count("FROM payments WHERE tenant_id='a'"),1);
  });
  await check('FLOW 3: a won deal whose commission cannot post keeps the import and queues an explicit review',async()=>{
    const unplanned=(await tx(c=>saveParticipant(c,u,{name:'No Plan',email:'noplan@example.test',role:'salesperson',status:'active'}))).id;
    await tx(c=>linkSalesman(c,u,{id:unplanned,externalId:'u-alice'}));
    const row=normalizeWebhookRow('opportunity.updated',opportunity({id:'opp-noplan',assignedTo:'u-alice',status:'won',updatedAt:'2026-03-04T00:00:00Z'}))!;
    const result=await approve((await tx(c=>queueTrackerEvent(c,'a','opportunities',row.row))).id);assert.equal(result.commission,'review_required');
    assert.equal(await count("FROM opportunities WHERE external_id='opp-noplan'"),1);assert.equal(await count("FROM payments WHERE event_key='opportunity:opp-noplan'"),0);
    const review=(await db.query("SELECT * FROM attribution_reviews WHERE tenant_id='a' AND evidence='opp-noplan'")).rows[0];assert.equal(review.candidate_id,unplanned);assert.match(review.reason,/could not post/);
    await tx(c=>linkSalesman(c,u,{id:unplanned,externalId:null}));
  });
  await check('FLOW 3: contact webhooks upsert the client by provider contact id without touching attribution',async()=>{
    const created=normalizeWebhookRow('contact.created',{id:'contact-2',firstName:'New',lastName:'Person',email:'NEW@Example.test',phone:'+1 555',companyName:'Acme',dateUpdated:'2026-03-01T00:00:00Z'})!;
    assert.equal(created.resource,'contacts');assert.deepEqual(created.row,{externalId:'contact-2',contactId:'contact-2',name:'New Person',email:'new@example.test',phone:'+1 555',company:'Acme',updatedAt:'2026-03-01T00:00:00Z'});
    const review=await tx(c=>queueTrackerEvent(c,'a','contacts',created.row));await approve(review.id);
    const client=(await db.query("SELECT * FROM clients WHERE tenant_id='a' AND ghl_contact_id='contact-2'")).rows;assert.equal(client.length,1);
    assert.equal(client[0].contact_name,'New Person');assert.equal(client[0].email,'new@example.test');assert.equal(client[0].company_name,'Acme');assert.equal(client[0].original_source,'ghl');assert.equal(client[0].salesperson_id,null);
    await db.query('UPDATE clients SET salesperson_id=$2 WHERE id=$1',[client[0].id,bob]);
    const updated=normalizeWebhookRow('contact.updated',{id:'contact-2',name:'Renamed Person',email:'new@example.test',updatedAt:'2026-03-05T00:00:00Z'})!;
    const reopened=await tx(c=>queueTrackerEvent(c,'a','contacts',updated.row));assert.equal(reopened.id,review.id);assert.equal(reopened.status,'pending');await approve(review.id);
    const after=(await db.query("SELECT * FROM clients WHERE tenant_id='a' AND ghl_contact_id='contact-2'")).rows;assert.equal(after.length,1);assert.equal(after[0].id,client[0].id);assert.equal(after[0].contact_name,'Renamed Person');assert.equal(after[0].phone,'+1 555');assert.equal(after[0].salesperson_id,bob);
    // Matching an existing local lead by hand attaches the provider id to it instead of creating a second client.
    const local=(await tx(c=>createLead(c,u,{name:'Local Lead',email:'local@example.test',source:'manual',date:'2026-01-01'}))).id;
    const matched=normalizeWebhookRow('contact.created',{id:'contact-local',email:'local@example.test'})!;await approve((await tx(c=>queueTrackerEvent(c,'a','contacts',matched.row))).id,{clientId:local});
    assert.equal((await db.query('SELECT ghl_contact_id,contact_name FROM clients WHERE id=$1',[local])).rows[0].ghl_contact_id,'contact-local');assert.equal(await count("FROM clients WHERE tenant_id='a' AND ghl_contact_id='contact-local'"),1);
    assert.equal(await count("FROM clients WHERE tenant_id='b' AND ghl_contact_id IS NOT NULL"),0);
  });
  await check('FLOW 3: the automatic path applies verified events only when the policy opts in and leaves problems in review',async()=>{
    const contact=normalizeWebhookRow('contact.created',{id:'contact-3',name:'Auto Contact',email:'auto@example.test'})!;
    await tx(c=>queueTrackerEvent(c,'a','contacts',contact.row));
    assert.deepEqual(await autoImportEvent(database,'a','contacts','contact-3'),{applied:false,action:'manual_review'});
    assert.equal(await count("FROM clients WHERE ghl_contact_id='contact-3'"),0);
    await tx(c=>mutations.pipelinePolicy(c,u,{pipelineId:'pipe-1',wonStageIds:['stage-won'],treatStatusWonAsWon:true,auto:true,receipt:'confirmed'}));
    assert.equal((await autoImportEvent(database,'a','contacts','contact-3')).applied,true);
    assert.equal(await count("FROM clients WHERE tenant_id='a' AND ghl_contact_id='contact-3'"),1);
    assert.equal((await db.query("SELECT status,reviewed_by FROM import_reviews WHERE external_id='contact-3'")).rows[0].status,'approved');
    const orphan=normalizeWebhookRow('opportunity.created',opportunity({id:'opp-orphan',contactId:'contact-missing',status:'won'}))!;
    await tx(c=>queueTrackerEvent(c,'a','opportunities',orphan.row));
    assert.deepEqual(await autoImportEvent(database,'a','opportunities','opp-orphan'),{applied:false,action:'unmatched_contact'});
    const stuck=(await db.query("SELECT status,reason FROM import_reviews WHERE external_id='opp-orphan'")).rows[0];assert.equal(stuck.status,'pending');assert.match(stuck.reason,/needs review/);
    assert.equal(await count("FROM opportunities WHERE external_id='opp-orphan'"),0);
    const won=normalizeWebhookRow('opportunity.created',opportunity({id:'opp-2',contactId:'contact-3',monetaryValue:'500',pipelineStageId:'stage-won',updatedAt:'2026-03-06T00:00:00Z'}))!;
    await tx(c=>queueTrackerEvent(c,'a','opportunities',won.row));
    const auto:any=await autoImportEvent(database,'a','opportunities','opp-2');assert.equal(auto.applied,true);assert.equal(auto.commission,'confirmed');
    assert.equal(await count("FROM payments WHERE event_key='opportunity:opp-2'"),1);
    const earning=(await db.query("SELECT amount_minor,salesperson_id FROM commission_ledger WHERE event_key='opportunity:opp-2:0'")).rows[0];assert.equal(String(earning.amount_minor),'5000');assert.equal(earning.salesperson_id,bob);
    assert.equal((await db.query("SELECT after->>'actorId' AS actor FROM audit_logs WHERE entity_type='import' AND action='approved' AND after->>'externalId'='opp-2'")).rows[0].actor,'system:pipeline');
    // Redelivery of the same event is acknowledged; nothing is re-applied.
    await tx(c=>queueTrackerEvent(c,'a','opportunities',won.row));
    assert.deepEqual(await autoImportEvent(database,'a','opportunities','opp-2'),{applied:false,action:'approved'});
    assert.equal(await count("FROM payments WHERE event_key='opportunity:opp-2'"),1);assert.equal(await count("FROM commission_ledger WHERE event_key LIKE 'opportunity:opp-2:%'"),1);
    assert.deepEqual(await autoImportEvent(database,'a','opportunities','never-queued'),{applied:false,action:'not_queued'});
    await tx(c=>mutations.pipelinePolicy(c,u,{pipelineId:'pipe-1',wonStageIds:['stage-won'],treatStatusWonAsWon:true,auto:false,receipt:'pending'}));
  });
  await check('FLOW 3: pending receipt mode records the won deal without commission until collection is confirmed',async()=>{
    const row=normalizeWebhookRow('opportunity.updated',opportunity({id:'opp-pending',monetaryValue:'800',status:'won',updatedAt:'2026-03-07T00:00:00Z'}))!;
    assert.equal((await approve((await tx(c=>queueTrackerEvent(c,'a','opportunities',row.row))).id)).commission,'pending');
    const payment=(await db.query("SELECT * FROM payments WHERE event_key='opportunity:opp-pending'")).rows[0];assert.equal(payment.receipt_status,'pending');assert.equal(await count("FROM commission_ledger WHERE payment_id=$1",[payment.id]),0);
    await tx(c=>mutations.confirmReceipt(c,u,{id:payment.id,reason:'Bank statement confirms collection'}));
    assert.equal((await db.query('SELECT receipt_status FROM payments WHERE id=$1',[payment.id])).rows[0].receipt_status,'confirmed');
    assert.equal(String((await db.query('SELECT amount_minor FROM commission_ledger WHERE payment_id=$1',[payment.id])).rows[0].amount_minor),'8000');
  });
  await check('FLOW 3: Stripe inbox review pre-matches the client by email only when unambiguous, without auto-approval',async()=>{
    await pg.exec(OPERATIONS_SCHEMA_SQL);
    const event=(reference:string,email:string)=>({occurredAt:1767225600,refundReference:null,test:false,amountMinor:'2500',currency:'USD',date:'2026-01-01',paymentReference:reference,provider:'stripe',providerAccount:'acct-test',productId:'',email,customerId:null});
    await db.query("INSERT INTO tracker_inbox(id,tenant_id,provider,external_id,kind,payload,status) VALUES('inbox-1','a','stripe','pi_1','payment',$1::jsonb,'pending'),('inbox-2','a','stripe','pi_2','payment',$2::jsonb,'pending'),('inbox-3','a','stripe','pi_3','payment',$3::jsonb,'pending')",[JSON.stringify(event('ch_1','deal@example.test')),JSON.stringify(event('ch_2','dup@example.test')),JSON.stringify(event('ch_3','nobody@example.test'))]);
    await tx(c=>createLead(c,u,{name:'Dup One',email:'dup@example.test',source:'manual',date:'2026-01-01'}));await tx(c=>createLead(c,u,{name:'Dup Two',email:'dup@example.test',source:'manual',date:'2026-01-01'}));
    assert.equal((await db.query("SELECT status FROM tracker_inbox WHERE id='inbox-1'")).rows[0].status,'pending');
    await tx(c=>reviewEvent(c,u,{id:'inbox-1',reason:'Statement matched',confirmMapping:true,confirmUnattributed:true}));
    const payment=(await db.query("SELECT client_id,receipt_status FROM payments WHERE event_key='provider:stripe:acct-test:ch_1'")).rows[0];assert.equal(payment.client_id,lead);assert.equal(payment.receipt_status,'confirmed');
    await assert.rejects(tx(c=>reviewEvent(c,u,{id:'inbox-2',reason:'Ambiguous',confirmMapping:true,confirmUnattributed:true})),{code:'invalid_input'});
    await assert.rejects(tx(c=>reviewEvent(c,u,{id:'inbox-3',reason:'Unknown',confirmMapping:true,confirmUnattributed:true})),{code:'invalid_input'});
    assert.equal((await db.query("SELECT status FROM tracker_inbox WHERE id='inbox-2'")).rows[0].status,'pending');
    await assert.rejects(tx(c=>reviewEvent(c,u,{id:'inbox-2',clientId:lead,reason:'Wrong pick',confirmMapping:true,confirmUnattributed:true})),{code:'email_mismatch'});
  });
  console.log(`${checks} isolated FLOW 2/3 pipeline scenarios passed.`);
}finally{await pg.close();}
