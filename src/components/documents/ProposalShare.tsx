// FLOW 4 — share-for-approval UI pieces used by the Documents page: the prospect fields for the
// create modal, the Send dialog (email prefilled, link returned once), the copyable link banner and
// the post-approval status card. API calls go straight to /api/documents (ops: send | link).
import {useState,type ReactNode} from 'react';
import {Link} from 'react-router-dom';
import {Send,Copy,Check,Loader2,CheckCircle2,UserPlus,Receipt,Briefcase,Link2} from 'lucide-react';
import {Button,Field,Input} from '../ui';
import {Modal} from '../ui/Modal';
import {formatCurrency,formatDate} from '../../lib/format';
import type {ClientDocument} from '../../types';

export interface Prospect{name:string;email:string;company:string;phone:string;setupFee:number;monthlySubscription:number}
/** The extra FLOW 4 columns /api/documents returns on every document row. */
export type DocRow=ClientDocument&{prospect?:Prospect|null;sentTo?:string|null;hasLink?:boolean;linkExpiresAt?:string|null;acceptedAt?:string|null;acceptedByName?:string|null;acceptedEmail?:string|null;createdClientId?:string|null;createdOpportunityId?:string|null;receiptEventKey?:string|null};
export interface ShareResult{link:string;to:string|null;email:'sent'|'queued'|'unavailable';emailError:string|null;expiresAt:string|null;status:string}
export const emptyProspect=():Prospect=>({name:'',email:'',company:'',phone:'',setupFee:0,monthlySubscription:0});
export const recipientOf=(d:DocRow,clientName:(id:string|null)=>string)=>d.clientId?clientName(d.clientId):d.prospect?(d.prospect.company||d.prospect.name):'—';

async function docPost(payload:Record<string,unknown>):Promise<any>{const r=await fetch('/api/documents',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)});const b=await r.json().catch(()=>({}));if(!r.ok)throw new Error(b.message||b.error||`http_${r.status}`);return b;}
export const shareDocument=(id:string,to:string):Promise<ShareResult>=>docPost({op:'send',id,to});
export const mintDocumentLink=(id:string):Promise<ShareResult>=>docPost({op:'link',id});
export async function copyText(s:string){try{await navigator.clipboard.writeText(s);return true;}catch{const el=document.createElement('textarea');el.value=s;document.body.appendChild(el);el.select();const ok=document.execCommand('copy');el.remove();return ok;}}

const EMAIL_LABEL:Record<string,string>={sent:'Email sent',queued:'Email queued — delivery is not configured on this server, so copy the link and send it yourself.',unavailable:'Copy the link and send it to the recipient.'};
const EMAIL_ERRORS:Record<string,string>={email_not_configured:'Email sending is not configured (RESEND_API_KEY / TRACKER_EMAIL_FROM).',email_disabled:'Email sending is switched off in this environment.',delivery_unknown:'Delivery was not confirmed — check the provider log before resending.'};

export function CopyButton({text,label='Copy link'}:{text:string;label?:string}){
  const [done,setDone]=useState(false),[failed,setFailed]=useState(false);
  return <><Button variant="secondary" size="sm" type="button" onClick={async()=>{try{const ok=await copyText(text);setDone(ok);setFailed(!ok);setTimeout(()=>setDone(false),1800);}catch{setFailed(true);}}}>{done?<Check className="h-4 w-4"/>:<Copy className="h-4 w-4"/>}{done?'Copied':label}</Button>{failed&&<span role="status" className="text-xs text-amber-700">Select the URL and copy it manually.</span>}</>;
}

/** Keep the returned URL visible and selectable even when clipboard access is blocked. */
export function LinkBanner({result,onClose}:{result:ShareResult;onClose:()=>void}){
  const [useApp,setUseApp]=useState(false);
  const original=new URL(result.link);
  const appLink=new URL(original.pathname,window.location.origin).href;
  const link=useApp?appLink:result.link;
  const alternate=original.origin!==window.location.origin;
  return <div className="space-y-4">
    <p className="flex items-center gap-2 font-semibold text-emerald-700"><CheckCircle2 size={18}/>Your proposal link is ready</p>
    {result.to&&<p className="text-sm">{EMAIL_LABEL[result.email]}{result.email==='queued'&&result.emailError?` ${EMAIL_ERRORS[result.emailError]||''}`:''}</p>}
    <label className="block text-sm font-medium">Proposal URL<input aria-label="Proposal URL" className="mt-2 block w-full rounded-lg border border-slate-300 bg-slate-50 p-3 text-sm text-slate-800" readOnly value={link} onFocus={e=>e.currentTarget.select()} onClick={e=>e.currentTarget.select()}/></label>
    <div className="flex flex-wrap items-center gap-3"><CopyButton key={link} text={link}/><a className="st-text-link" href={link} target="_blank" rel="noreferrer">Open proposal ↗</a></div>
    {alternate&&<div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900"><p>{useApp?'This address uses the same proposal and tracking.':'If your custom domain is not connected yet, use the current app address to share this proposal.'}</p><button type="button" className="mt-2 font-semibold underline" onClick={()=>setUseApp(!useApp)}>{useApp?'Use custom domain':'Use current app address'}</button></div>}
    <p className="text-xs text-slate-500">Anyone with this private link can view and approve the proposal.{result.expiresAt?` Expires ${formatDate(result.expiresAt)}.`:''} Copy it before leaving this page. Previously shared links remain valid until they expire or you cancel the proposal. Revisions have their own approval links.</p>
    <Button variant="secondary" onClick={onClose}>Done</Button>
  </div>;
}

/** "Send" dialog: recipient email prefilled from the client / prospect / last send. */
export function ShareDialog({doc,defaultTo,onClose,onSent}:{doc:DocRow|null;defaultTo:string;onClose:()=>void;onSent:(r:ShareResult)=>void}){
  const [to,setTo]=useState(defaultTo),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const submit=async()=>{if(!doc)return;setBusy(true);setError('');try{onSent(await shareDocument(doc.id,to.trim()));}catch(e){const m=e instanceof Error?e.message:'';setError(m==='recipient_email_invalid'?'Enter a valid email address.':m==='invalid_transition'?'This document can no longer be sent (already signed or canceled).':m||'Could not send.');}finally{setBusy(false);}};
  return <Modal open={!!doc} onClose={onClose} title={`Send ${doc?.kind??'document'} for approval`} footer={<div className="flex justify-end gap-2"><Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button><Button onClick={submit} disabled={busy||!to.trim()}>{busy?<Loader2 className="h-4 w-4 animate-spin"/>:<Send className="h-4 w-4"/>}Send</Button></div>}>
    <div className="space-y-3 text-sm text-slate-600 dark:text-slate-400"><p>Emails a private approval link for <strong>{doc?.title}</strong>. The recipient reviews it, types their name to sign, and the deal enters commission tracking automatically.</p>
      <Field label="Recipient email"><Input type="email" value={to} onChange={e=>setTo(e.target.value)} placeholder="client@company.com" autoFocus/></Field>
      {error&&<p role="alert" className="rounded-lg bg-rose-50 p-3 text-rose-700 dark:bg-rose-950/30 dark:text-rose-300">{error}</p>}</div></Modal>;
}

/** Prospect fields for "New proposal → New prospect" (client is created on approval). */
export function ProspectFields({value,onChange}:{value:Prospect;onChange:(p:Prospect)=>void}){
  const set=(k:keyof Prospect,v:string)=>onChange({...value,[k]:k==='setupFee'||k==='monthlySubscription'?Math.max(0,Number(v)||0):v});
  return <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
    <Field label="Contact name"><Input value={value.name} onChange={e=>set('name',e.target.value)} placeholder="Jane Doe" required/></Field>
    <Field label="Email"><Input type="email" value={value.email} onChange={e=>set('email',e.target.value)} placeholder="jane@company.com" required/></Field>
    <Field label="Company"><Input value={value.company} onChange={e=>set('company',e.target.value)} placeholder="Company (optional)"/></Field>
    <Field label="Phone"><Input value={value.phone} onChange={e=>set('phone',e.target.value)} placeholder="Optional"/></Field>
    <Field label="Setup fee" hint="Expected on approval; becomes the pending receipt."><Input type="number" min={0} step="0.01" value={value.setupFee||''} onChange={e=>set('setupFee',e.target.value)} placeholder="0"/></Field>
    <Field label="Monthly subscription"><Input type="number" min={0} step="0.01" value={value.monthlySubscription||''} onChange={e=>set('monthlySubscription',e.target.value)} placeholder="0"/></Field>
  </div>;
}

/** Post-approval status: who approved, what was created, and where to confirm the cash. */
export function ApprovalCard({doc}:{doc:DocRow}){
  if(doc.status!=='signed'||!doc.acceptedAt)return null;const clientId=doc.createdClientId||doc.clientId;
  const item=(icon:ReactNode,body:ReactNode)=><span className="st-approval-item">{icon}{body}</span>;
  return <div className="st-approval"><CheckCircle2 className="h-4 w-4 text-emerald-600"/><span>Approved by <strong>{doc.acceptedByName||doc.acceptedEmail||'recipient'}</strong> on {formatDate(doc.acceptedAt)}</span>
    {item(<UserPlus className="h-3.5 w-3.5"/>,clientId?<Link className="st-text-link" to={`/clients/${clientId}`}>{doc.createdClientId?'Client created':'Client'}</Link>:'No client')}
    {doc.createdOpportunityId&&item(<Briefcase className="h-3.5 w-3.5"/>,<Link className="st-text-link" to="/opportunities">Won opportunity</Link>)}
    {item(<Receipt className="h-3.5 w-3.5"/>,doc.receiptEventKey?<Link className="st-text-link" to="/payments">Receipt pending — confirm when paid</Link>:'No receipt to confirm')}
    {doc.amount>0&&<span className="st-approval-amount">{formatCurrency(doc.amount)}</span>}</div>;
}
