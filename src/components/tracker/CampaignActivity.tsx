import {useEffect,useState} from 'react';
import {Link} from 'react-router-dom';
import {useTracker} from '../TrackerGate';
import {displayMinor} from '../../lib/exact-commission';
import {Action,Empty,Message,Pager,Tabs,useRemote} from './Experience';

export default function CampaignActivity({campaignId='',salespersonId='',from='',to='',initialMode='all'}:{campaignId?:string;salespersonId?:string;from?:string;to?:string;initialMode?:string}){
 const {workspace}=useTracker(),digits=workspace?.payout_terms?.minorDigits??2;
 const [person,setPerson]=useState(salespersonId),[mode,setMode]=useState(initialMode),[page,setPage]=useState(1),[revision,setRevision]=useState(0);
 const [data,setData]=useState<any>(null),[error,setError]=useState('');
 const people=useRemote('people',{limit:'100',sort:'name'}),params=new URLSearchParams({resource:'campaignActivity',campaignId,salespersonId:salespersonId||person,from,to,mode,page:String(page)}).toString();
 useEffect(()=>{const controller=new AbortController();let active=false;setData(null);setError('');
  const refresh=async()=>{if(active||controller.signal.aborted)return;active=true;try{const response=await fetch('/api/operations?'+params,{signal:controller.signal});const result=await response.json();if(!response.ok)throw new Error(result.message||'Orders could not be loaded.');if(!controller.signal.aborted){setData(result);setError('');}}catch(e){if(!controller.signal.aborted)setError((e as Error).message);}finally{active=false;}};
  void refresh();const timer=setInterval(()=>{if(document.visibilityState==='visible')void refresh();},15000);const focus=()=>{if(document.visibilityState==='visible')void refresh();};document.addEventListener('visibilitychange',focus);
  return()=>{controller.abort();clearInterval(timer);document.removeEventListener('visibilitychange',focus);};
 },[params,revision]);
 const money=(value:string,currency=workspace?.currency||'USD')=>displayMinor(value||'0',currency,digits);
 const groups=(kind:string)=>data?.summary.filter((r:any)=>r.mode===kind)||[];
 const successful=data?.summary.reduce((n:number,r:any)=>n+r.completed,0)||0;
 return <section className="st-panel" aria-label="Campaign tracking">
  <div className="st-panel-heading"><div><h2>Campaign tracking</h2><p className="st-help">Share a salesman’s link. Purchases appear here automatically.</p></div><Link className="st-button" to="/people">Salesman affiliate links</Link></div>
  <Message error={error}/>
  <div className="st-stats st-stats-four" style={{padding:'0 20px'}}>
   <div className="st-stat st-small-stat"><p>Tracked visits</p><strong>{data?.clicks??'—'}</strong><small>Identified referral visits in this period</small></div>
   <div className="st-stat st-small-stat"><p>Completed orders</p><strong>{data?successful:'—'}</strong><small>Live and test orders, shown separately below</small></div>
   {['live','test'].map(kind=><div key={kind} className="st-stat st-small-stat"><p>{kind==='test'?'Test sales':'Live sales'}</p>{groups(kind).length?groups(kind).map((r:any)=><div key={r.currency}><strong>{money(r.revenue_minor,r.currency)}</strong><small>{money(r.commission_minor,r.currency)} {kind==='test'?'test commission':'commission'} · {r.completed} orders</small></div>):<><strong>{data?money('0'):'—'}</strong><small>{kind==='test'?'Practice purchases — never payable':'Verified collected revenue after refunds'}</small></>}</div>)}
  </div>
  <div className="st-toolbar"><Tabs value={mode} onChange={v=>{setMode(v);setPage(1);}} tabs={[{id:'all',label:'All orders'},{id:'live',label:'Live orders'},{id:'test',label:'Test orders'}]}/>{!salespersonId&&<label>Salesman <select className="st-select" aria-label="Order salesman" value={person} onChange={e=>{setPerson(e.target.value);setPage(1);}}><option value="">All salesmen</option>{people.data?.rows.map((p:any)=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label>}<Action onClick={()=>setRevision(r=>r+1)}>Refresh</Action></div>
  {!data&&!error?<p role="status" className="st-loading">Loading tracked orders…</p>:data?.rows.length?<div className="st-table-wrap"><table className="st-table"><thead><tr>{['Order','Campaign','Salesman','Mode','Sale','Commission','Status','Date'].map(label=><th key={label}>{label}</th>)}</tr></thead><tbody>{data.rows.map((r:any)=>{const complete=['auto_posted','test_calculated'].includes(r.status);return <tr key={r.id}><td><strong>{r.customer_name||'Checkout order'}</strong><small className="st-block">{r.order_id}</small></td><td>{r.campaign_name}</td><td>{r.salesperson_name}</td><td><span className="st-muted">{r.mode==='test'?'Test purchase':r.mode==='live'?'Live purchase':'Verifying mode'}</span></td><td>{complete?money(r.revenue_minor,r.currency):'Awaiting payment'}</td><td>{complete?money(r.commission_minor,r.currency):'—'}</td><td>{complete?'Tracked successfully':r.reason?'Needs attention':'Checking payment'}{r.reason&&!complete&&<details><summary>Details</summary><p className="st-help">{r.reason}</p></details>}</td><td>{new Date(r.created_at).toLocaleString(undefined,{timeZone:data.timezone,dateStyle:'medium',timeStyle:'short'})}</td></tr>;})}</tbody></table></div>:<Empty title="No tracked orders yet" description="Assign a salesman to an active campaign, copy their affiliate link, and complete a purchase. Test checkouts appear here too."/>}
  <div className="st-toolbar"><small className="st-muted">Updates automatically every 15 seconds. Test orders are visible here and excluded from live earnings and payouts.</small></div>
  <Pager page={page} total={data?.total||0} limit={10} onPage={setPage}/>
 </section>;
}
