// /p/<token> — FLOW 4 public approval page (no login). Renders the proposal/contract from
// /api/proposal?token=…, then "Approve & sign" (name, email, typed signature, agreement) POSTs the
// acceptance; the server creates the client / opportunity / pending receipt. The token is read from the
// URL path (not router params) so this page works wherever it is mounted in the tree.
import {useEffect,useRef,useState,type FormEvent} from 'react';
import {CheckCircle2,Loader2,ShieldCheck} from 'lucide-react';
import {DocumentPreview} from '../components/documents/DocumentPreview';
import type {DocumentKind,DocumentSection,DocumentStyle} from '../types';

interface PublicProposal{kind:DocumentKind;title:string;style:DocumentStyle;status:string;sections:DocumentSection[];branding:{businessName:string;logoUrl:string;website:string;companyAddress:string;contactEmail:string;contactPhone:string;brandTone:string};recipient:{name:string;company:string;email:string}|null;salesperson:{name:string;email:string}|null;amount:{total:number;setupFee:number;monthly:number;dueNow:number;currency:string};accepted:{name:string|null;at:string|null}|null;sentAt:string|null}
const money=(n:number,c:string)=>{try{return n.toLocaleString('en-US',{style:'currency',currency:c||'USD',maximumFractionDigits:2});}catch{return `${c} ${n.toFixed(2)}`;}};
const when=(iso:string|null|undefined)=>iso?new Date(iso).toLocaleDateString('en-US',{year:'numeric',month:'long',day:'numeric'}):'';
const ERRORS:Record<string,string>={invalid_token:'This link is not valid. Ask your contact to send a new one.',link_expired:'This link has expired. Ask your contact to send a new one.',unavailable:'This document is no longer available.',rate_limited:'Too many requests. Please try again in a few minutes.'};
export const tokenFromPath=(pathname:string)=>{const m=/^\/p\/([A-Za-z0-9_-]+)\/?$/.exec(pathname);return m?m[1]:'';};

export default function ProposalPublic(){
  const token=tokenFromPath(window.location.pathname);
  const [doc,setDoc]=useState<PublicProposal|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[done,setDone]=useState<{name:string;at:string|null}|null>(null),[form,setForm]=useState({name:'',email:'',signature:'',agree:false});const started=useRef(false);
  useEffect(()=>{if(started.current)return;started.current=true;document.title='Review & approve';fetch(`/api/proposal?token=${encodeURIComponent(token)}`).then(async r=>{const b=await r.json().catch(()=>({}));if(!r.ok)throw new Error(ERRORS[b.error]||b.message||'This link could not be opened.');setDoc(b);if(b.accepted)setDone(b.accepted);setForm(f=>({...f,name:b.recipient?.name||'',email:b.recipient?.email||''}));document.title=`${b.title} · ${b.branding?.businessName||'Review & approve'}`;}).catch(e=>setError(e.message));},[token]);
  const submit=async(e:FormEvent)=>{e.preventDefault();setBusy(true);setError('');try{const r=await fetch('/api/proposal',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token,...form})});const b=await r.json().catch(()=>({}));if(!r.ok)throw new Error(ERRORS[b.error]||b.message||'Your approval could not be saved.');setDone(b.accepted);window.scrollTo({top:0,behavior:'smooth'});}catch(e){setError(e instanceof Error?e.message:'Your approval could not be saved.');}finally{setBusy(false);}};
  const b=doc?.branding,kindLabel=doc?.kind==='contract'?'contract':'proposal';
  return <main className="st-proposal">
    <header className="st-proposal-top"><div className="st-proposal-brand">{b?.logoUrl?<img src={b.logoUrl} alt=""/>:<span className="st-proposal-mark">{(b?.businessName||'P').slice(0,1)}</span>}<div><strong>{b?.businessName||'Review & approve'}</strong>{doc?.recipient&&<small>Prepared for {doc.recipient.name}{doc.recipient.company?` · ${doc.recipient.company}`:''}</small>}</div></div>{doc&&<span className={`st-badge ${done?'st-green':''}`}>{done?'Approved':doc.kind==='contract'?'Contract':'Proposal'}</span>}</header>
    {error&&!doc&&<p role="alert" className="st-proposal-error">{error}</p>}
    {!doc&&!error&&<p role="status" className="st-loading"><Loader2 className="inline h-4 w-4 animate-spin"/> Loading…</p>}
    {doc&&<div className="st-proposal-layout">
      <section className="st-proposal-paper"><DocumentPreview kind={doc.kind} title={doc.title} style={doc.style} sections={doc.sections} branding={doc.branding}/></section>
      <aside className="st-proposal-side">
        {done?<div className="st-proposal-done" role="status"><CheckCircle2 className="h-8 w-8"/><h2>Thank you{done.name?`, ${done.name.split(' ')[0]}`:''}!</h2><p>This {kindLabel} was approved{done.at?` on ${when(done.at)}`:''}. {b?.businessName||'The team'} has been notified and will be in touch about next steps{doc.amount.dueNow>0?` and the ${money(doc.amount.dueNow,doc.amount.currency)} due on approval`:''}.</p>{(doc.salesperson?.email||b?.contactEmail)&&<p><small>Questions? Email <a className="st-text-link" href={`mailto:${doc.salesperson?.email||b?.contactEmail}`}>{doc.salesperson?.name||b?.businessName}</a>.</small></p>}</div>
        :<>
          {(doc.amount.total>0)&&<div className="st-proposal-summary"><h3>Summary</h3>{doc.amount.setupFee>0&&<div><span>Setup fee</span><b>{money(doc.amount.setupFee,doc.amount.currency)}</b></div>}{doc.amount.monthly>0&&<div><span>Monthly</span><b>{money(doc.amount.monthly,doc.amount.currency)}/mo</b></div>}<div className="is-total"><span>Due on approval</span><b>{money(doc.amount.dueNow,doc.amount.currency)}</b></div></div>}
          <form className="st-proposal-form" onSubmit={submit}><h3><ShieldCheck className="h-4 w-4"/> Approve & sign</h3><p>Review the {kindLabel}, then sign by typing your name. Your approval is recorded with the date and time.</p>
            <label className="st-field"><span>Full name</span><input value={form.name} onChange={e=>setForm({...form,name:e.target.value})} required minLength={2} maxLength={200} autoComplete="name"/></label>
            <label className="st-field"><span>Email</span><input type="email" value={form.email} onChange={e=>setForm({...form,email:e.target.value})} required maxLength={254} autoComplete="email"/></label>
            <label className="st-field"><span>Signature (type your full name)</span><input className="st-proposal-signature" value={form.signature} onChange={e=>setForm({...form,signature:e.target.value})} required minLength={2} maxLength={200} placeholder={form.name||'Your name'} autoComplete="off"/></label>
            <label className="st-proposal-agree"><input type="checkbox" checked={form.agree} onChange={e=>setForm({...form,agree:e.target.checked})} required/><span>I have reviewed this {kindLabel} and agree to its terms. Typing my name above is my electronic signature.</span></label>
            {error&&<p role="alert" className="st-proposal-error">{error}</p>}
            <button type="submit" className="st-button st-primary" disabled={busy||!form.agree}>{busy?'Saving…':`Approve & sign ${kindLabel}`}</button>
          </form></>}
        {b&&(b.contactEmail||b.contactPhone||b.website)&&<p className="st-proposal-contact">{b.businessName}{b.contactEmail?` · ${b.contactEmail}`:''}{b.contactPhone?` · ${b.contactPhone}`:''}{b.website?` · ${b.website.replace(/^https?:\/\//,'')}`:''}</p>}
      </aside>
    </div>}
  </main>;
}
