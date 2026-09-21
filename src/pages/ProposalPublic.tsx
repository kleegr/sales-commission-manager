import {ProposalDecision,ProposalValue} from '../components/documents/ProposalDecision';
import {ProposalConversation} from '../components/documents/ProposalConversation';
import {proposalTotals} from '../lib/proposal-pricing';
import {ProposalSheet} from '../components/documents/ProposalSheet';
import type {DocumentLineItem} from '../types';
// /p/<token> — FLOW 4 public approval page (no login). Renders the proposal/contract from
// /api/proposal?token=…, then "Approve & sign" (name, email, typed signature, agreement) POSTs the
// acceptance; the server creates the client / opportunity / pending receipt. The token is read from the
// URL path (not router params) so this page works wherever it is mounted in the tree.
import {useEffect,useRef,useState,type FormEvent} from 'react';
import {CheckCircle2,Loader2,ShieldCheck,Printer,Mail} from 'lucide-react';
import type {DocumentKind,DocumentSection,DocumentStyle} from '../types';

interface PublicProposal{workspace?:any;lineItems?:DocumentLineItem[];digits?:number;expiresAt?:string|null;invoice?:{status:string;url:string|null}|null;kind:DocumentKind;title:string;style:DocumentStyle;status:string;sections:DocumentSection[];branding:{businessName:string;logoUrl:string;website:string;companyAddress:string;contactEmail:string;contactPhone:string;brandTone:string};recipient:{name:string;company:string;email:string}|null;salesperson:{name:string;email:string}|null;amount:{total:number;setupFee:number;monthly:number;dueNow:number;currency:string};accepted:{name:string|null;at:string|null}|null;sentAt:string|null}
const money=(n:number,c:string)=>{try{return n.toLocaleString('en-US',{style:'currency',currency:c||'USD',maximumFractionDigits:2});}catch{return `${c} ${n.toFixed(2)}`;}};
const when=(iso:string|null|undefined)=>iso?new Date(iso).toLocaleDateString('en-US',{year:'numeric',month:'long',day:'numeric'}):'';
const ERRORS:Record<string,string>={invalid_token:'This link is not valid. Ask your contact to send a new one.',link_expired:'This link has expired. Ask your contact to send a new one.',unavailable:'This document is no longer available.',rate_limited:'Too many requests. Please try again in a few minutes.'};
export const tokenFromPath=(pathname:string)=>{const m=/^\/p\/([A-Za-z0-9_-]+)\/?$/.exec(pathname);return m?m[1]:'';};

export default function ProposalPublic(){
  const token=tokenFromPath(window.location.pathname);
  const [selectedPackage,setSelectedPackage]=useState(''),[messageBusy,setMessageBusy]=useState(false);
  const [doc,setDoc]=useState<PublicProposal|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[done,setDone]=useState<{name:string;at:string|null}|null>(null),[form,setForm]=useState({name:'',email:'',signature:'',agree:false});const started=useRef(false);
  useEffect(()=>{if(started.current)return;started.current=true;document.title='Review & approve';fetch(`/api/proposal?token=${encodeURIComponent(token)}`).then(async r=>{const b=await r.json().catch(()=>({}));if(!r.ok)throw new Error(ERRORS[b.error]||b.message||'This link could not be opened.');setDoc(b);setSelectedPackage(b.workspace?.selectedPackageId||'');if(b.accepted)setDone(b.accepted);setForm(f=>({...f,name:b.recipient?.name||'',email:b.recipient?.email||''}));document.title=`${b.title} · ${b.branding?.businessName||'Review & approve'}`;}).catch(e=>setError(e.message));},[token]);
  const submit=async(e:FormEvent)=>{e.preventDefault();setBusy(true);setError('');try{const r=await fetch('/api/proposal',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token,...form,packageId:selectedPackage})});const b=await r.json().catch(()=>({}));if(!r.ok)throw new Error(ERRORS[b.error]||b.message||'Your approval could not be saved.');setDone(b.accepted);const refreshed=await fetch(`/api/proposal?token=${encodeURIComponent(token)}`).then(r=>r.json());if(refreshed.title)setDoc(refreshed);else setDoc(d=>d?{...d,status:'signed',invoice:b.invoice||d.invoice}:d);window.scrollTo({top:0,behavior:'smooth'});}catch(e){setError(e instanceof Error?e.message:'Your approval could not be saved.');}finally{setBusy(false);}};
  const choices=doc?.workspace?.packages||[];
  const selected=choices.find((p:any)=>p.id===selectedPackage);
  const displayedItems=selected?.items||doc?.lineItems||[];
  async function sendMessage(message:Record<string,unknown>){setMessageBusy(true);try{const response=await fetch('/api/proposal',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({op:'message',token,...message})});const result=await response.json();if(!response.ok)throw new Error(result.message||'Could not save your question.');const fresh=await fetch(`/api/proposal?token=${encodeURIComponent(token)}`).then(r=>r.json());if(fresh.title)setDoc(fresh);}finally{setMessageBusy(false);}}
  const b=doc?.branding,kindLabel=doc?.kind==='contract'?'contract':'proposal';
  return <main className="proposal-presentation">
    <nav className="proposal-client-toolbar" aria-label="Proposal actions"><div><span>{b?.businessName||'Your proposal'}</span><div>{doc&&<><a href="#proposal-approval"><ShieldCheck size={15}/>{done?'View approval':'Review & sign'}</a><button onClick={()=>window.print()}><Printer size={15}/>Save as PDF</button></>}</div></div></nav>
    {error&&!doc&&<p role="alert" className="st-proposal-error">{error}</p>}
    {!doc&&!error&&<p role="status" className="st-loading"><Loader2 className="inline h-4 w-4 animate-spin"/> Loading proposal…</p>}
    {doc&&<div className="proposal-document-wrap">
      <ProposalDecision packages={choices} selected={selectedPackage} onSelect={setSelectedPackage} locked={!!done} currency={doc.amount.currency} digits={doc.digits??2}/><ProposalSheet title={doc.title} sections={doc.sections} branding={doc.branding} items={displayedItems} currency={doc.amount.currency} digits={doc.digits} recipient={doc.recipient} preparedBy={doc.salesperson?.name} sentAt={doc.sentAt} expiresAt={doc.expiresAt}/>
      {!doc.lineItems?.length&&doc.amount.total>0&&<div className="proposal-legacy-amount"><strong>First payment: {money(doc.amount.dueNow,doc.amount.currency)}</strong>{doc.amount.monthly>0&&<span>Recurring monthly: {money(doc.amount.monthly,doc.amount.currency)}</span>}<small>Approval and payment are separate steps.</small></div>}
      {doc.workspace&&<><div className="ps-dates">{doc.workspace.effectiveDate&&<span>Effective: {doc.workspace.effectiveDate}</span>}{doc.workspace.deliveryDate&&<span>Target delivery: {doc.workspace.deliveryDate}</span>}{doc.workspace.renewalDate&&<span>Renewal review: {doc.workspace.renewalDate}</span>}</div>{doc.workspace.value&&<ProposalValue assumptions={doc.workspace.value} currency={doc.amount.currency} digits={doc.digits??2} monthlyMinor={(proposalTotals(displayedItems).recurring.month||0n).toString()}/>}</>}
      <aside className="st-proposal-side" id="proposal-approval" aria-label="Proposal approval">
        {done?<div className="st-proposal-done" role="status"><CheckCircle2 className="h-8 w-8"/><h2>Thank you{done.name?`, ${done.name.split(' ')[0]}`:''}!</h2><p>This {kindLabel} was approved{done.at?` on ${when(done.at)}`:''}. Your signed approval has been saved. Contact {b?.businessName||'the team'} about next steps{doc.amount.dueNow>0?` and the ${money(doc.amount.dueNow,doc.amount.currency)} first payment`:''}.</p>{(doc.salesperson?.email||b?.contactEmail)&&<p><small>Questions? Email <a className="st-text-link" href={`mailto:${doc.salesperson?.email||b?.contactEmail}`}>{doc.salesperson?.name||b?.businessName}</a>.</small></p>}</div>
        :<>
          <form className="st-proposal-form" onSubmit={submit}><span className="proposal-eyebrow">THE NEXT STEP</span><h3><ShieldCheck className="h-4 w-4"/> Approve your {kindLabel}</h3><p>Review the {kindLabel}, then sign by typing your name. Your approval is recorded with the date and time.</p>
            <label className="st-field"><span>Full name</span><input value={form.name} onChange={e=>setForm({...form,name:e.target.value})} required minLength={2} maxLength={200} autoComplete="name"/></label>
            <label className="st-field"><span>Email</span><input type="email" value={form.email} onChange={e=>setForm({...form,email:e.target.value})} required maxLength={254} autoComplete="email"/></label>
            <label className="st-field"><span>Signature (type your full name)</span><input className="st-proposal-signature" value={form.signature} onChange={e=>setForm({...form,signature:e.target.value})} required minLength={2} maxLength={200} placeholder={form.name||'Your name'} autoComplete="off"/></label>
            <label className="st-proposal-agree"><input type="checkbox" checked={form.agree} onChange={e=>setForm({...form,agree:e.target.checked})} required/><span>I have reviewed this {kindLabel} and agree to its terms. Typing my name above is my electronic signature.</span></label>
            {error&&<p role="alert" className="st-proposal-error">{error}</p>}
            {choices.length>0&&!selectedPackage&&<p className="proposal-caption">Choose a package above before signing.</p>}
            <button type="submit" className="st-button st-primary" disabled={busy||!form.agree||(choices.length>0&&!selectedPackage)}>{busy?'Saving…':`Approve & sign ${kindLabel}`}</button>
          </form></>}
        {done&&doc.invoice?.url&&/^https:\/\//.test(doc.invoice.url)&&<a className="st-button st-primary" href={doc.invoice.url} target="_blank" rel="noreferrer">{doc.invoice.status==='paid'?'View paid invoice':'View invoice & pay'}</a>}
        {doc.expiresAt&&!done&&<p className="proposal-caption">Approval link expires {when(doc.expiresAt)}.</p>}
        {(doc.salesperson?.email||b?.contactEmail)&&<a className="proposal-question" href={`mailto:${doc.salesperson?.email||b?.contactEmail}`}><Mail size={18}/><span><strong>Have a question?</strong><small>Contact {doc.salesperson?.name||b?.businessName||'your representative'}</small></span></a>}{b&&(b.contactEmail||b.contactPhone||b.website)&&<p className="st-proposal-contact">{b.businessName}{b.contactEmail?` · ${b.contactEmail}`:''}{b.contactPhone?` · ${b.contactPhone}`:''}{b.website?` · ${b.website.replace(/^https?:\/\//,'')}`:''}</p>}
      </aside>
      <div className="ps-client-section"><ProposalConversation messages={doc.workspace?.messages||[]} onSend={sendMessage} busy={messageBusy}/></div>
    </div>}
  </main>;
}
