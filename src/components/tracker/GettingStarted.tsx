// ============================================================================
// GettingStarted — plain-language onboarding guidance (Wave 3, crystal-clear UX)
//
// AdminGettingStarted: a collapsible checklist that walks a new admin through the
// whole flow — add products, set commission, add & assign salespeople, send a
// proposal, get paid. Each step's done/not-done is derived from real counts
// (best-effort) and links straight to the page that completes it.
//
// SalespersonGuide: the simpler "create a proposal -> send -> get paid" path.
// ============================================================================
import {useEffect,useState} from 'react';
import {Link} from 'react-router-dom';
import {CheckCircle2,Circle,ArrowRight,Rocket,ChevronDown,ChevronUp} from 'lucide-react';
import {trackerGet} from '../../lib/tracker-client';

interface Count{total:number;loaded:boolean;error?:boolean}
function useCount(resource:string,params:Record<string,string>={},revision=0):Count{
 const [c,setC]=useState<Count>({total:0,loaded:false});
 const key=JSON.stringify(params);
 useEffect(()=>{let live=true;trackerGet(resource,{limit:'1',...JSON.parse(key)}).then(b=>{if(live)setC({total:Number(b.total??(b.rows?.length||0)),loaded:true});}).catch(()=>{if(live)setC({total:0,loaded:true,error:true});});return()=>{live=false;};},[resource,key,revision]);
 return c;
}

export function AdminGettingStarted({refreshToken=0}:{refreshToken?:number}){
 const [open,setOpen]=useState(true);
 const products=useCount('products',{},refreshToken),campaigns=useCount('campaigns',{},refreshToken),people=useCount('people',{},refreshToken),assignments=useCount('productAssignments',{},refreshToken),payouts=useCount('payouts',{},refreshToken);
 // Documents live on a separate endpoint (/api/documents), counted directly.
 const [docCount,setDocCount]=useState(0),[docsLoaded,setDocsLoaded]=useState(false),[docsError,setDocsError]=useState(false);
 useEffect(()=>{let live=true;fetch('/api/documents',{headers:{accept:'application/json'}}).then(r=>{if(!r.ok)throw new Error('load');return r.json();}).then(b=>{if(live){setDocCount((b?.documents||[]).filter((d:any)=>d.kind==='proposal'&&['sent','viewed','signed'].includes(d.status)).length);setDocsLoaded(true);setDocsError(false);}}).catch(()=>{if(live){setDocsLoaded(true);setDocsError(true);}});return()=>{live=false;};},[refreshToken]);
 const steps=[
  {label:'Add your products',hint:'Add products manually or sync them from Kleeger, and set each price.',to:'/products',cta:'Add products',done:products.total>0},
  {label:'Create a campaign & commission',hint:'Set how much your team earns, and optionally pay some products differently.',to:'/plans',cta:'Create a campaign',done:campaigns.total>0},
  {label:'Add salespeople & assign products',hint:'Add your team, then choose which products each person can sell.',to:'/people',cta:'Add people',done:people.total>0&&assignments.total>0},
  {label:'Create & send a proposal',hint:'Build a proposal from your products and send it for approval.',to:'/documents',cta:'Create a proposal',done:docCount>0},
  {label:'Get paid & pay commission',hint:'Payment is collected in Kleeger; then run payouts to your team.',to:'/payouts',cta:'Open payouts',done:payouts.total>0},
 ];
 const done=steps.filter(s=>s.done).length,total=steps.length,pct=Math.round(done/total*100);
 return <section className="st-panel st-guide"><button type="button" className="st-guide-head" aria-expanded={open} onClick={()=>setOpen(v=>!v)}><span className="st-guide-icon"><Rocket size={18}/></span><span className="st-guide-title"><strong>Workspace onboarding</strong><small className="st-help">{![products,campaigns,people,assignments,payouts].every(c=>c.loaded)||!docsLoaded?"Loading your setup progress…":[products,campaigns,people,assignments,payouts].some(c=>c.error)||docsError?"Some setup progress is unavailable. Refresh to retry.":done===total?"Setup complete — revisit any step below.":`${done} of ${total} complete · Your path from first product to first payout`}</small></span>{open?<ChevronUp size={18}/>:<ChevronDown size={18}/>}</button>
  <div className="st-guide-bar"><span style={{width:`${pct}%`}}/></div>
  {open&&<ol className="st-guide-list">{steps.map((s,i)=><li key={s.label} className={s.done?'is-done':''}><span className="st-guide-num">{s.done?<CheckCircle2 size={18}/>:<span className="st-guide-count">{i+1}</span>}</span><span className="st-guide-body"><span className="st-guide-label">{s.label}</span><small className="st-help">{s.hint}</small></span><Link to={s.to} className="st-button st-guide-cta">{s.done?"Review":s.cta}<ArrowRight size={14}/></Link></li>)}</ol>}</section>;
}

export function SalespersonGuide(){
 const steps=[
  {n:1,label:'Create a proposal',hint:'Pick your products, set quantities and prices, and add a title.',to:'/documents'},
  {n:2,label:'Send it for approval',hint:'Share a private link — your customer approves and pays in Kleeger.',to:'/documents'},
  {n:3,label:'Track your commission',hint:'Once the sale is paid, watch your earnings and payouts here.',to:'/payouts'},
 ];
 return <section className="st-panel st-guide"><div className="st-guide-head-static"><span className="st-guide-icon"><Rocket size={18}/></span><span className="st-guide-title"><strong>How to earn</strong><small className="st-help">Create a proposal, send it, and get paid — here's the whole flow.</small></span></div>
  <ol className="st-guide-list">{steps.map(s=><li key={s.n}><span className="st-guide-num"><span className="st-guide-count">{s.n}</span></span><span className="st-guide-body"><span className="st-guide-label">{s.label}</span><small className="st-help">{s.hint}</small></span><Link to={s.to} className="st-button st-guide-cta">Go<ArrowRight size={14}/></Link></li>)}</ol></section>;
}
