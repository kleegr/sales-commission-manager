import {Badge,Message,useRemote} from './Experience';
import {sourceLabel} from './CampaignSource';

export default function CampaignSummary({campaign:c}:{campaign:any}){
 const links=useRemote('links',{campaignId:c.id,limit:'100'});
 const policy=c.tracking_policy||{};
 const date=(v:string,fallback:string)=>v?new Date(String(v).slice(0,10)+'T12:00:00Z').toLocaleDateString(undefined,{timeZone:'UTC',year:'numeric',month:'short',day:'numeric'}):fallback;
 const tracking:Record<string,string>={verified_test:'Test checkout verified',verified:'Tracking verified',unverified:'Setup needs verification'};
 const modes:Record<string,string>={auto:'Automatic — test and live purchases',test:'Test purchases only',live:'Live purchases',off:'Visits only'};
 return <div className="st-dialog st-campaign-summary">
 <div className="st-summary-intro"><Badge value={c.status}/><p>{c.description||'Campaign setup and referral activity.'}</p></div>
 <div className="st-stats st-stats-four">{[['Visits',c.clicks??0],['Live customers',c.conversions??0],['Test orders',c.test_orders??0],['Salesman links',links.data?.total??'…']].map(([label,value])=><div className="st-stat" key={label}><p>{label}</p><strong>{value}</strong></div>)}</div>
 <dl className="st-summary-fields">{[['Funnel or website',sourceLabel(c)],['Tracking',tracking[c.verification_status]||'Not yet verified'],['Purchase mode',modes[policy.automation]||'Visits only'],['Starts',date(c.starts_at,'Available now')],['Ends',date(c.ends_at,'No end date')],['Referral window',`${policy.windowDays||30} days`],['Credit goes to',policy.touch==='last'?'Last referral':'First referral']].map(([label,value])=><div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}<div className="st-summary-wide"><dt>Customer landing page</dt><dd>{c.destination_url||'Hosted referral form'}</dd></div></dl>
 <h3>Salesmen</h3><Message error={links.error}/>{links.loading?<p role="status">Loading salesman links…</p>:links.data?.rows.length?<ul className="st-summary-salesmen">{links.data.rows.map((r:any)=><li key={r.link_id}><span>{r.salesperson_name||'Salesman'}</span><Badge value={r.active?'active':'inactive'}/></li>)}</ul>:<p className="st-help">No salesmen assigned yet. Use Edit to assign your sales team.</p>}
 {links.data?.total>100&&<p className="st-help">Showing the first 100 links. Open Affiliate links to browse everyone.</p>}
 <p className="st-help">Test orders confirm tracking works. Only verified live purchases can create payable commissions.</p>
 </div>;
}
