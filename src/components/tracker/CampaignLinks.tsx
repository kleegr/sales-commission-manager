import {affiliateURL} from '../../lib/affiliate-link';
import SubmissionCampaign from './SubmissionCampaign';
import {displayMinor} from '../../lib/exact-commission';
import {useTracker} from '../TrackerGate';
import {useEffect,useState} from 'react';
import {Action,Message,Pager,Tabs,useRemote} from './Experience';
import CampaignActivity from './CampaignActivity';

export default function CampaignLinks({campaignId,status,destination}:{campaignId:string;status:string;destination?:string}){
 const {workspace}=useTracker(),digits=workspace?.payout_terms?.minorDigits??2;
 const [events,setEvents]=useState<any[]>([]),[refresh,setRefresh]=useState(0),[advanced,setAdvanced]=useState(false),[selected,setSelected]=useState<string|null>(null);
 const [activity,setActivity]=useState<any>(null),[activityError,setActivityError]=useState(''),[chosenMode,setChosenMode]=useState<string|null>(null);
 const campaign=useRemote('campaigns',{id:campaignId,limit:'1'},refresh),current=campaign.data?.rows?.[0],automation=current?.tracking_policy?.automation;
 const submissionSource=['form','survey'].includes(current?.tracking_policy?.source?.selection?.kind);
 const [page,setPage]=useState(1),[notice,setNotice]=useState(''),[error,setError]=useState('');
 const result=useRemote('links',{campaignId,page:String(page),limit:'25'});
 useEffect(()=>{if(!current||submissionSource)return;const c=new AbortController();let busy=false;const load=async()=>{if(busy||c.signal.aborted)return;busy=true;try{const r=await fetch(`/api/operations?resource=campaignActivity&includeSalesmen=1&campaignId=${encodeURIComponent(campaignId)}`,{signal:c.signal});const b=await r.json();if(!r.ok)throw Error(b.message||'Salesman results could not be loaded.');if(!c.signal.aborted){setActivity(b);setActivityError('');}}catch(e){if(!c.signal.aborted)setActivityError((e as Error).message);}finally{busy=false;}};void load();const timer=setInterval(()=>{if(document.visibilityState==='visible')void load();},15000);return()=>{c.abort();clearInterval(timer);};},[campaignId,refresh,!!current,submissionSource]);
 useEffect(()=>{if(!advanced)return;const c=new AbortController();fetch(`/api/operations?resource=checkoutEvents&campaignId=${encodeURIComponent(campaignId)}`,{signal:c.signal}).then(async r=>r.ok?r.json():{rows:[]}).then(b=>{if(!c.signal.aborted)setEvents(b.rows||[]);}).catch(()=>{});return()=>c.abort();},[campaignId,refresh,advanced]);
 const mode=chosenMode||(automation==='test'||(activity?.summary.some((s:any)=>s.mode==='test'&&s.completed)&&!activity?.summary.some((s:any)=>s.mode==='live'&&s.completed))?'test':'live');
 const money=(n:string,currency=workspace?.currency||'USD')=>displayMinor(n||'0',currency,digits);
 const connected=['script_seen','verified_test','verified_sale'].includes(current?.verification_status);
 if(campaign.loading&&!current)return <p role="status">Loading campaign links…</p>;
 if(submissionSource)return <><Message error={result.error||campaign.error}/>{result.loading?<p role="status">Loading salesman links…</p>:<SubmissionCampaign campaign={current} links={result.data?.rows||[]}/>}<Pager page={page} limit={25} total={result.data?.total||0} onPage={setPage}/></>;
 return <section aria-label="Campaign salesmen">
  <div className="st-panel-heading" style={{padding:'0 0 16px'}}><div><h3>Salesman performance</h3><p className="st-help">See who brought each order. Share their personal link.</p></div><Action onClick={()=>setRefresh(n=>n+1)}>Refresh</Action></div>
  {status!=='active'&&<p className="st-help">This campaign is not active. Activate it before sharing links.</p>}
  {current&&destination&&(!['test','live','auto'].includes(automation)||!connected)&&<p className="st-help">This source is not yet connected for automatic purchases. <Action onClick={()=>setAdvanced(true)}>Open setup</Action></p>}
  <Tabs value={mode} onChange={setChosenMode} tabs={[{id:'live',label:'Live orders'},{id:'test',label:'Test orders'}]}/>
  <Message error={error||result.error||activityError||campaign.error} notice={notice}/>
  {result.loading?<p role="status">Loading salesmen…</p>:!result.data?.rows.length?<p>Assign salesmen to create their personal links.</p>:<div className="st-table-wrap"><table className="st-table"><thead><tr><th>Salesman</th><th>Orders</th><th>Sales</th><th>Commission</th><th><span className="sr-only">Affiliate link</span></th></tr></thead><tbody>
   {result.data.rows.map((r:any)=>{const stats=activity?.salesmen?.filter((s:any)=>s.salesperson_id===r.salesperson_id&&s.mode===mode)||[],orders=stats.reduce((n:number,s:any)=>n+s.completed,0),pending=stats.reduce((n:number,s:any)=>n+s.pending,0),url=affiliateURL(r.link_id,destination,automation);return <tr key={r.link_id}><td><strong>{r.salesperson_name||'Salesman'}</strong>{!r.active&&<small className="st-block">Removed from campaign</small>}</td><td>{activity?<><Action onClick={()=>setSelected(selected===r.salesperson_id?null:r.salesperson_id)}>{orders} {orders===1?'order':'orders'}</Action>{pending>0&&<small className="st-block">{pending} checking payment</small>}</>:'—'}</td><td>{activity?(stats.length?stats.map((s:any)=><div key={s.currency}>{money(s.revenue_minor,s.currency)}</div>):money('0')):'—'}</td><td>{activity?(stats.length?stats.map((s:any)=><div key={s.currency}>{money(s.commission_minor,s.currency)}</div>):money('0')):'—'}</td><td><Action disabled={!r.active||campaign.loading||!!campaign.error} onClick={async()=>{try{await navigator.clipboard.writeText(url);setNotice(`Link copied for ${r.salesperson_name||'salesman'}.`);setError('');}catch{setAdvanced(true);setError('Open Links & setup below to select and copy the link.');}}}>Copy link</Action></td></tr>;})}
  </tbody></table></div>}
  {(result.data?.total||0)>25&&<Pager page={page} limit={25} total={result.data.total} onPage={setPage}/>}
  <p className="st-help" style={{marginTop:12}}>{mode==='test'?'Test results only — excluded from payouts.':'Verified orders and commissions, after refunds.'}</p>
  {selected&&<div style={{marginTop:16}}><Action onClick={()=>setSelected(null)}>Close order details</Action><CampaignActivity key={`${selected}:${mode}`} campaignId={campaignId} salespersonId={selected} initialMode={mode}/></div>}
  <details style={{marginTop:20}} open={advanced} onToggle={e=>setAdvanced(e.currentTarget.open)}><summary>Links & setup</summary>
   {destination&&<p className="st-help" style={{overflowWrap:'anywhere'}}>Destination: {destination}</p>}
   {result.data?.rows.map((r:any)=><label className="st-field" key={r.link_id}><span>{r.salesperson_name} — affiliate link</span><input readOnly value={affiliateURL(r.link_id,destination,automation)} onFocus={e=>e.target.select()}/></label>)}
   {destination&&!['test','live','auto'].includes(automation)&&<p className="st-setup-banner">This link tracks the visit and passes its referralClick identifier to the destination. To capture form submissions, surveys, bookings or external payments, connect a signed source event in Settings → Funnels, events, tax forms &amp; exports. A visit alone does not earn commission.</p>}
   {destination&&['test','live','auto'].includes(automation)&&<><p className="st-help">{connected?'Tracking connected.':'Connect this checkout page to capture purchases automatically.'}</p><details><summary>Checkout connection setup</summary><p>Install once in the website or funnel’s Head tracking code, including its checkout and thank-you pages, then publish:</p><pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{`<script src="${window.location.origin}/affiliate.js"></script>`}</pre><p>Keep GHL’s Optimize JavaScript setting off for this tracking script.</p></details><details><summary>Recent checkout checks</summary><Action onClick={()=>setRefresh(n=>n+1)}>Refresh checkout results</Action>{events.map(e=><div key={e.id}><strong>{e.status.replace(/_/g,' ')}</strong>{e.reason&&<p>{e.reason}</p>}{e.results?.map((r:any)=><p key={r.transactionId}>{displayMinor(r.amountMinor,r.currency,digits)} sale{r.commissionMinor!==undefined?` → ${displayMinor(r.commissionMinor,r.currency,digits)} test commission`:''}</p>)}{e.status==='awaiting_payment'&&<Action onClick={async()=>{try{const r=await fetch('/api/operations',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'retryCheckout',data:{id:e.id}})});const b=await r.json();if(!r.ok)throw new Error(b.message||'Verification could not complete.');setRefresh(n=>n+1);}catch(err){setError((err as Error).message);}}}>Check payment now</Action>}</div>)}</details></>}
  </details>
 </section>;
}
