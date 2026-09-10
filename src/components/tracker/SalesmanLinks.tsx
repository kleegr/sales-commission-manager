import {useState} from 'react';
import {Link} from 'react-router-dom';
import {affiliateURL} from '../../lib/affiliate-link';
import {Action,Empty,Message,Pager,useRemote} from './Experience';

export default function SalesmanLinks({salespersonId}:{salespersonId:string}){
 const [page,setPage]=useState(1),[notice,setNotice]=useState(''),[error,setError]=useState('');
 const result=useRemote('links',{salespersonId,page:String(page),limit:'25'});
 return <section className="st-dialog"><p>Each campaign below has this salesman’s own link. Copy it and share it with customers.</p><Message error={error||result.error} notice={notice}/>
 {result.loading?<p role="status">Loading affiliate links…</p>:!result.data?.rows.length?<Empty title="No campaigns assigned" description="Create a campaign and select this salesman to generate their link."/>:result.data.rows.map((r:any)=>{const c=r.campaign_context||{},url=affiliateURL(r.link_id,c.destination,c.mode),active=r.active&&c.status==='active';return <div className="st-disclosure" key={r.link_id}><h3>{c.name||'Campaign'}</h3><p>{active?'Ready to share':'Campaign is not active'}{c.mode==='test'?' · Test purchases':''}</p><label className="st-field"><span>Affiliate link for {c.name}</span><input readOnly value={url} onFocus={e=>e.target.select()}/></label><Action primary disabled={!active} onClick={async()=>{try{await navigator.clipboard.writeText(url);setNotice(`Link copied for ${c.name}.`);setError('');}catch{setError('Select the link and copy it manually.');}}}>Copy affiliate link</Action></div>;})}
 <Pager page={page} limit={25} total={result.data?.total||0} onPage={setPage}/><Link className="st-button" to="/">View tracked orders on Dashboard</Link></section>;
}
