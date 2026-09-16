import {useState} from 'react';
import {Copy,Check,ExternalLink} from 'lucide-react';
import {Action,Empty,Message,useRemote} from './Experience';

// Per-product affiliate tracking links for one salesperson.
//
// Admin view: pass salespersonId to see that rep's links. Rep self-view: omit it
// — the productLinks read resource self-scopes to the logged-in salesperson, so a
// rep only ever sees their own links. Each link is `${base}/pl/<link_id>`; sharing
// it and a later purchase auto-credits the rep's commission (set on the product).
export default function ProductLinks({salespersonId}:{salespersonId?:string}){
 const [notice,setNotice]=useState(''),[error,setError]=useState(''),[copied,setCopied]=useState('');
 const result=useRemote('productLinks',salespersonId?{salespersonId}:{});
 const rows=(result.data?.rows||[]).filter((r:any)=>r.active);
 async function copy(url:string,name:string){try{await navigator.clipboard.writeText(url);setCopied(url);setNotice(`Link copied for ${name}.`);setError('');setTimeout(()=>setCopied(''),1500);}catch{setError('Select the link and copy it manually.');}}
 return <div className="st-product-links"><Message error={error||result.error} notice={notice}/>
  {result.loading?<p className="st-loading" role="status">Loading tracking links…</p>:!rows.length?<Empty title="No product links yet" description="Assign a product to this salesperson to generate their tracking link. They share it, and a purchase auto-credits their commission."/>:<>
   <p className="st-help">Each product this salesperson can sell has its own tracking link. They share it with customers; a purchase through the link auto-credits their commission.</p>
   {rows.map((r:any)=><div className="st-disclosure" key={r.link_id}><h3>{r.product_name}</h3>
    <label className="st-field"><span>Tracking link{r.destination_url?'':' (no buy page set — add a destination URL on the product)'}</span><input readOnly value={r.url} onFocus={e=>e.target.select()}/></label>
    <div className="st-row-buttons"><Action primary onClick={()=>void copy(r.url,r.product_name)}>{copied===r.url?<><Check size={15}/>Copied</>:<><Copy size={15}/>Copy link</>}</Action>{r.destination_url&&<a className="st-button" href={r.url} target="_blank" rel="noreferrer"><ExternalLink size={15}/>Preview</a>}</div></div>)}</>}
 </div>;
}
