import {useState} from 'react';
import {Link,useSearchParams} from 'react-router-dom';
import CampaignActivity from '../../components/tracker/CampaignActivity';
import {useTracker} from '../../components/TrackerGate';
import {displayMinor} from '../../lib/exact-commission';
import {Action,Header,Message,useRemote,useLiveRevision} from '../../components/tracker/Experience';
export default function TrackerDashboard(){
 const {workspace}=useTracker(),[search]=useSearchParams();
 const [from,setFrom]=useState(''),[to,setTo]=useState(''),[campaignId,setCampaign]=useState(''),[refresh,setRefresh]=useState(0);
 const [revision,refreshBalances]=useLiveRevision(),campaigns=useRemote('campaigns',{limit:'100'}),overview=useRemote('overview',{},revision);
 const earnings=overview.data?.earnings.find((r:any)=>r.currency===workspace?.currency),money=(v:string)=>displayMinor(v||'0',workspace?.currency||'USD',workspace?.payout_terms?.minorDigits??2);
 return <div className="st-page st-dashboard-page"><Header title="Dashboard" description="Your campaigns and sales team, at a glance."><Link className="st-button" to="/people">Salesman links</Link><Link className="st-button st-primary" to="/plans">Manage campaigns</Link></Header>
 <div className="st-filter-bar"><label className="st-date">From<input aria-label="Dashboard from date" type="date" value={from} onChange={e=>setFrom(e.target.value)}/></label><label className="st-date">To<input aria-label="Dashboard to date" type="date" value={to} min={from||undefined} onChange={e=>setTo(e.target.value)}/></label><select className="st-select" aria-label="Dashboard campaign" value={campaignId} onChange={e=>setCampaign(e.target.value)}><option value="">All campaigns</option>{campaigns.data?.rows.map((c:any)=><option key={c.id} value={c.id}>{c.name}</option>)}</select><Action onClick={()=>{setRefresh(n=>n+1);refreshBalances();}}>Refresh</Action>{(from||to||campaignId)&&<Action onClick={()=>{setFrom('');setTo('');setCampaign('');}}>Clear filters</Action>}</div>
 <Message error={campaigns.error}/>{from&&to&&from>to?<Message error="Choose an end date on or after the start date."/>:<CampaignActivity refreshToken={refresh} campaignId={campaignId} from={from} to={to} dashboard initialMode={['live','test'].includes(search.get('mode')||'')?search.get('mode')!:'auto'}/>}
 <section className="st-panel st-finance-strip"><div><h2>Live payout balances</h2><p className="st-help">All-time balances. Test commissions are excluded.</p></div><Message error={overview.error}/>{[['Ready for payout',earnings?.payable_minor],['On hold',earnings?.held_minor],['Paid',earnings?.paid_minor]].map(([label,value])=><div key={label}><small>{label}</small><strong>{overview.data?money(value):'—'}</strong></div>)}<Link className="st-button" to="/payouts">View payouts</Link></section>
 <div className="st-report-links"><Link to="/reports">Detailed financial reports</Link><Link to="/ledger">Commission ledger</Link><Link to="/sync-review">Review imports</Link></div>
 </div>;
}
