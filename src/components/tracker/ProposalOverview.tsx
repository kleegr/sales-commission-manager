import {useEffect,useState} from 'react';
import {Link} from 'react-router-dom';
import {listDocuments} from '../../lib/resource-client';
import type {ClientDocument} from '../../types';

const labels:Record<string,string>={draft:'Draft',sent:'Shared',viewed:'Viewed',signed:'Approved',canceled:'Canceled'};
export default function ProposalOverview({refreshToken,from,to,campaignId}:{refreshToken:number;from:string;to:string;campaignId:string}){
 const [docs,setDocs]=useState<ClientDocument[]|null>(null),[error,setError]=useState(''),[enabled,setEnabled]=useState(true);
 useEffect(()=>{let active=true,pending=false;
   async function load(){if(pending)return;pending=true;try{const result=await listDocuments({kind:'proposal'});if(active){setDocs(result.documents.filter(d=>d.kind==='proposal'));setEnabled(result.features.proposals);setError('');}}catch{if(active)setError('Proposal data could not be refreshed. Use Refresh to try again.');}finally{pending=false;}}
   void load();const timer=setInterval(()=>{if(!document.hidden)void load();},30000);return()=>{active=false;clearInterval(timer);};
 },[refreshToken]);
 if(!enabled)return null;
 const rows=(docs||[]).filter(d=>{const date=d.createdAt.slice(0,10);return(!from||date>=from)&&(!to||date<=to)&&(!campaignId||d.campaignId===campaignId);});
 const counts=[['Total proposals',rows.length],['Drafts',rows.filter(d=>d.status==='draft').length],['Awaiting approval',rows.filter(d=>['sent','viewed'].includes(d.status)).length],['Approved',rows.filter(d=>d.status==='signed').length]] as const;
 const recent=[...rows].sort((a,b)=>Date.parse(b.updatedAt)-Date.parse(a.updatedAt)).slice(0,5);
 return <section className="dashboard-proposals" aria-label="Proposal overview">
   <div className="st-panel-heading"><div><h2>Proposals</h2><p className="st-help">From draft to client approval. Date filters use proposal creation date (UTC); sales mode applies to orders below.</p></div><Link className="st-button" to="/documents">View proposals →</Link></div>
   {error&&<p role="alert" className="proposal-error">{error}{docs?' Showing the last loaded data.':''}</p>}
   <div className="dashboard-proposal-workspace"><div className="dashboard-proposal-stats">{counts.map(([label,count])=><div className="st-panel" key={label}><span>{label}</span><strong>{docs?count:'—'}</strong></div>)}</div>
   <div className="st-panel dashboard-proposal-recent"><div className="st-panel-heading"><h3>Recent proposals</h3><span className="st-help">Latest updates</span></div>
     {!docs?<p role="status">{error?'Proposal data unavailable.':'Loading proposals…'}</p>:!recent.length?<p className="st-help">{from||to||campaignId?'No proposals match these filters.':'No proposals yet. Create your first proposal to see its progress here.'}</p>:<ul>{recent.map(d=><li key={d.id}><div><Link to="/documents">{d.title||'Untitled proposal'}</Link><small>Updated {new Date(d.updatedAt).toLocaleDateString()}</small></div><span className={`dashboard-proposal-status is-${d.status}`}>{labels[d.status]||d.status}</span></li>)}</ul>}
   </div></div><p className="st-help">Approved proposals are agreements, not collected revenue. Sales and commissions follow verified payments.</p>
 </section>;
}
