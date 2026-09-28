import SalesmanLinks from '../../components/tracker/SalesmanLinks';
import ProductLinks from '../../components/tracker/ProductLinks';
import {useEffect,useState} from 'react';
import {Link} from 'react-router-dom';
import {Filter} from 'lucide-react';
import {Reference} from '../../components/TrackerForm';
import {Modal} from '../../components/ui';
import {useAuth} from '../../store/AuthContext';
import {useTracker} from '../../components/TrackerGate';
import {trackerPost,trackerCSV} from '../../lib/tracker-client';
import {displayMinor} from '../../lib/exact-commission';
import {Action,Avatar,Badge,Empty,ExportIcon,Field,Header,Message,Pager,SearchBox,Tabs,useRemote,usePreferences,currencyMinorDigits} from '../../components/tracker/Experience';

// Compact, tidy campaign column: campaigns render as pill chips, capped at two
// with a "+N more" toggle so a salesman on many campaigns no longer stretches
// the row into a tall stacked list.
function StructureChips({items}:{items?:any[]}){
 const [open,setOpen]=useState(false);
 if(!items?.length)return <span className="st-muted">Unassigned</span>;
 const shown=open?items:items.slice(0,2),extra=items.length-shown.length;
 return <div className="st-chips">{shown.map((c:any)=><Link key={c.id} to="/campaigns" className="st-chip" title={c.name}>{c.name}</Link>)}{extra>0&&<button type="button" className="st-chip st-chip-more" onClick={()=>setOpen(true)}>+{extra} more</button>}{open&&items.length>2&&<button type="button" className="st-chip st-chip-more" onClick={()=>setOpen(false)}>Show less</button>}</div>;
}

// A salesman is a connected sub-account user (login can be linked), an imported contact, or an outside person kept external.
const salesmanKind=(r:any)=>r?.ghl_user_id?'user':r?.source_contact_id?'contact':'external';
const kindLabel:Record<string,string>={user:'Connected user',contact:'Contact',external:'External'};
export function TypeBadge({person}:{person:any}){const kind=salesmanKind(person);return <span className={`st-badge st-kind-${kind}`}>{kindLabel[kind]}</span>;}

export default function Salesmen(){
 const {user}=useAuth(),admin=['admin','owner'].includes(user?.role||''),{workspace}=useTracker(),pref=usePreferences();
 const [q,setQ]=useState(''),[status,setStatus]=useState(''),[page,setPage]=useState(1),[limit,setLimit]=useState(10),[revision,setRevision]=useState(0);
 const [dialog,setDialog]=useState<'manual'|null>(null),[edit,setEdit]=useState<any>(null),[notice,setNotice]=useState(''),[error,setError]=useState('');
 const [linkPerson,setLinkPerson]=useState<any>(null);
 const [mode,setMode]=useState('live'),[activity,setActivity]=useState<any>(null),[activityError,setActivityError]=useState('');
 const state=useRemote('salesmen',{q,status,page:String(page),limit:String(limit),sort:'name'},revision);
 const changeSearch=(v:string)=>{setQ(v);setPage(1);};
 // A row's money can be in a different currency than the workspace: use that currency's own minor digits, keeping the workspace override for its own currency.
 const digitsFor=(c:string)=>c&&c===workspace?.currency?(workspace?.payout_terms?.minorDigits??2):currencyMinorDigits(c||'USD');
 const money=(n:string,currency=workspace?.currency||'USD')=>displayMinor(n||'0',currency,digitsFor(currency));
 // Per-salesman order results across every campaign, same source as the campaign dashboard's salesman table.
 useEffect(()=>{const c=new AbortController();(async()=>{try{const r=await fetch('/api/operations?resource=campaignActivity&includeSalesmen=1',{signal:c.signal});const b=await r.json();if(!r.ok)throw Error(b.message||'Salesman results could not be loaded.');if(!c.signal.aborted){setActivity(b);setActivityError('');}}catch(e){if(!c.signal.aborted)setActivityError((e as Error).message);}})();return()=>c.abort();},[revision]);
 return <div className="st-page"><Header title={pref.values.salesmanLabel} description="Manage your salesmen, campaign assignments and commission results."><Action onClick={()=>void trackerCSV('people',{q,status}).catch(e=>setError(e.message))}><ExportIcon/>Export</Action></Header>
 <Message error={error||state.error} notice={notice}/>
 <section className="st-panel"><div className="st-toolbar"><SearchBox value={q} onChange={changeSearch} placeholder="Search by salesman name or email"/><label className="st-filter"><Filter size={16}/><select aria-label="Salesman status" value={status} onChange={e=>{setStatus(e.target.value);setPage(1);}}><option value="">All statuses</option><option value="active">Active</option><option value="inactive">Inactive</option></select></label><Tabs value={mode} onChange={setMode} tabs={[{id:'live',label:'Live orders'},{id:'test',label:'Test orders'}]}/></div>
 {activityError&&<Message error={activityError}/>}
 {state.loading?<div className="st-loading" role="status">Loading salesmen…</div>:state.data?.rows?.length?<div className="st-table-wrap"><table className="st-table st-salesmen-table"><thead><tr>{['Name','Type','Sales Commission Structure','Clicks','Orders','Sales','Commission','Customers','Leads','Sub Affiliates','Owed','Paid','Revenue','Status','Actions'].map((h,i)=><th key={i} className={h==='Actions'?'st-action-cell':undefined}>{h}</th>)}</tr></thead><tbody>{state.data.rows.map((r:any)=><tr key={r.id}><td><button className="st-person" onClick={()=>{setEdit(r);setDialog('manual');}}><Avatar name={r.name}/><span><strong>{r.name}</strong><small>{r.email||'No email'}</small></span></button></td><td><TypeBadge person={r}/></td><td><StructureChips items={r.structures}/></td><td>{r.clicks||0}</td>{(()=>{const stats=activity?.salesmen?.filter((s:any)=>s.salesperson_id===r.id&&s.mode===mode)||[],orders=stats.reduce((n:number,s:any)=>n+s.completed,0),pending=stats.reduce((n:number,s:any)=>n+s.pending,0);
 // A row that is empty in the current mode but has orders in the other mode gets a visible switch, so test-only results are never mistaken for "no sales".
 const otherMode=mode==='live'?'test':'live',otherOrders=activity?.salesmen?.filter((s:any)=>s.salesperson_id===r.id&&s.mode===otherMode).reduce((n:number,s:any)=>n+s.completed+s.pending,0)||0;
 return <><td>{activity?<>{orders}{pending>0&&<small className="st-block">{pending} checking payment</small>}{!orders&&!pending&&otherOrders>0&&<small className="st-block"><button type="button" className="st-text-link" onClick={()=>setMode(otherMode)}>{otherOrders} {otherMode} {otherOrders===1?'order':'orders'}</button></small>}</>:'—'}</td><td>{activity?(stats.length?stats.map((s:any)=><div key={s.currency}>{money(s.revenue_minor,s.currency)}</div>):money('0')):'—'}</td><td>{activity?(stats.length?stats.map((s:any)=><div key={s.currency}>{money(s.commission_minor,s.currency)}</div>):money('0')):'—'}</td></>;})()}<td>{r.counts?.customers||0}</td><td>{r.counts?.leads||0}</td><td>{r.sub_affiliates||0}</td><td>{r.money?.map((m:any)=>displayMinor(m.owed,m.currency,digitsFor(m.currency))).join(' · ')||'—'}</td><td>{r.money?.map((m:any)=>displayMinor(m.paid,m.currency,digitsFor(m.currency))).join(' · ')||'—'}</td><td>{r.revenue?.map((m:any)=>displayMinor(m.amount,m.currency,digitsFor(m.currency))).join(' · ')||'—'}</td><td><Badge value={r.status}/></td><td className="st-action-cell"><div className="st-row-buttons"><Action onClick={()=>setLinkPerson(r)}>Affiliate links</Action><Action onClick={()=>{setEdit(r);setDialog('manual');}}>{admin?'Manage':'View'}</Action></div></td></tr>)}</tbody></table></div>:<Empty title={q||status?'No matching salesmen':'No salesmen yet'} description={q||status?'Try a different search or status filter.':'Your assigned salesmen will appear here.'}/>}
 <Pager total={state.data?.total||0} page={page} limit={limit} onPage={setPage} onLimit={n=>{setLimit(n);setPage(1);}} loading={state.loading}/></section>
 {linkPerson&&<Modal open title={`${linkPerson.name} — Affiliate links`} size="lg" onClose={()=>setLinkPerson(null)}><LinksModal salespersonId={linkPerson.id}/></Modal>}
 {dialog==='manual'&&<SalesmanForm person={edit} readOnly={!admin} onClose={()=>setDialog(null)} onSaved={()=>{setDialog(null);setNotice('Salesman saved.');setRevision(r=>r+1);}} onLinked={m=>{setDialog(null);setNotice(m);setRevision(r=>r+1);}}/>}
 </div>;
}
function SalesmanForm({person,readOnly,onClose,onSaved,onLinked}:{person:any;readOnly:boolean;onClose:()=>void;onSaved:()=>void;onLinked?:(message:string)=>void}){
 const names=person?.name?.split(' ')||[],[tab,setTab]=useState('basic');
 const [value,setValue]=useState<any>({firstName:names[0]||'',lastName:names.slice(1).join(' '),email:person?.email||'',phone:person?.phone||'',country:'',...person?.tracker_profile,role:person?.role||'salesperson',status:person?.status||'active',teamId:person?.team_id||'',parentId:person?.parent_salesperson_id||'',effectiveFrom:new Date().toISOString().slice(0,10)}),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const [linkId,setLinkId]=useState(''),[linkBusy,setLinkBusy]=useState(false);
 const plans=useRemote('plans',{limit:'100'}),teams=useRemote('teams',{limit:'100'});
 const field=(key:string,label:string,type='text',required=false)=><Field key={key} label={label}><input type={type} value={value[key]||''} required={required} disabled={readOnly||!!person?.ghl_user_id&&['firstName','lastName','email','phone'].includes(key)} onChange={e=>setValue({...value,[key]:e.target.value})}/></Field>;
 // Link / unlink login access. Commission history, links and assignments stay with the salesman either way.
 const link=async(externalId:string|null)=>{setLinkBusy(true);setError('');try{const r=await trackerPost('linkSalesman',{id:person.id,externalId});onLinked?.(r.linked?'Salesman linked to the connected user. Their existing login (if any) now opens this profile.':'Salesman kept as an external person. No login is attached.');}catch(e){setError((e as Error).message);}finally{setLinkBusy(false);}};
 return <Modal open title={person?<span className="st-title-with-badge">{person.name}<TypeBadge person={person}/></span>:'New Salesman'} onClose={()=>{if(!busy)onClose();}} size="lg"><div className="st-dialog"><div className="st-toolbar"><Tabs value={tab} onChange={setTab} tabs={[{id:'basic',label:'Basic Info'},{id:'details',label:'Details'},{id:'socials',label:'Socials'}]}/></div>
 <form onInvalid={e=>{// Required fields live on the (possibly hidden) Basic Info tab; a hidden invalid field aborts native submit with no feedback. Switch to that tab, then re-show the browser's validation bubble once it is visible.
 if(tab!=='basic'){e.preventDefault();const form=e.currentTarget;setTab('basic');setTimeout(()=>form.reportValidity(),0);}}} onSubmit={async e=>{e.preventDefault();setBusy(true);setError('');try{await trackerPost('salesman',{...value,id:person?.id});onSaved();}catch(e){setError((e as Error).message);}finally{setBusy(false);}}}>
 {person?.ghl_user_id&&<p className="st-help">Name and contact information are managed by your connected CRM. Local commission roles and assignments are managed here.</p>}
 <div hidden={tab!=='basic'}><div className="st-form-grid">{field('email','Email *','email',true)}{field('company','Company name')}{field('firstName','First name *','text',true)}{field('lastName','Last name *','text',!person?.ghl_user_id)}<Field label="Commission role"><select disabled={readOnly} value={value.role} onChange={e=>setValue({...value,role:e.target.value})}><option value="salesperson">Salesman</option><option value="affiliate">Affiliate</option><option value="partner">Partner</option></select></Field><Field label="Status"><select disabled={readOnly} value={value.status} onChange={e=>setValue({...value,status:e.target.value})}><option value="active">Active</option><option value="inactive">Inactive</option></select></Field></div>
 {!readOnly&&<details className="st-disclosure"><summary>Commission assignment & team</summary><div className="st-form-grid"><Field label="Assign commission plan (optional)"><select value={value.versionId||''} onChange={e=>setValue({...value,versionId:e.target.value})}><option value="">Keep current assignments</option>{plans.data?.rows.map((p:any)=><option key={p.id} value={p.id}>{p.name} · Version {p.version}</option>)}</select></Field>{field('effectiveFrom','Assignment begins','date')}<Field label="Team"><select value={value.teamId} onChange={e=>setValue({...value,teamId:e.target.value})}><option value="">No team</option>{teams.data?.rows.map((t:any)=><option key={t.id} value={t.id}>{t.name}</option>)}</select></Field><div><Reference field={{key:"parentId",label:"Parent participant",resource:"people",optional:true}} value={value.parentId} onChange={v=>setValue({...value,parentId:v})}/></div></div><p className="st-help">Overlapping assignments are checked before saving. Enrollment does not create a login or send an invitation.</p></details>}
 {person&&!readOnly&&<details className="st-disclosure st-login-access"><summary>Login access</summary><div><p className="st-login-state"><TypeBadge person={person}/>{person.ghl_user_id?<span>Linked to connected user <code>{person.ghl_user_id}</code>{person.ghl_role?` · ${person.ghl_role}`:''}{person.ghl_active===false?' · inactive in Kleeger':''}. Name and contact details follow the CRM.</span>:<span>No login is attached. This salesman is an outside person; you can link a sub-account user so their existing login opens this profile.</span>}</p>
 <div className="st-form-grid"><div><Reference field={{key:'externalId',label:'Connected user',resource:'directory',optional:true}} value={linkId} onChange={v=>setLinkId(v)}/></div><div className="st-row-buttons st-login-actions"><Action primary disabled={linkBusy||busy||!linkId||linkId===person.ghl_user_id} onClick={()=>void link(linkId)}>{linkBusy?'Linking…':person.ghl_user_id?'Relink to user':'Link to user'}</Action>{person.ghl_user_id&&<Action disabled={linkBusy||busy} onClick={()=>void link(null)}>Unlink (keep as external)</Action>}</div></div>
 <p className="st-help">Linking never creates a login or changes Kleeger permissions; it only connects an existing sub-account login to this salesman. A user already linked to another salesman must be unlinked there first.</p></div></details>}</div>
 <div hidden={tab!=='details'} className="st-form-grid">{field('website','Website','url')}{field('phone','Phone','tel')}{field('companyPhone','Company phone','tel')}{field('vatId','VAT ID')}{field('country','Country')}{field('address','Address')}{field('avatar','Avatar image URL','url')}</div>
 <div hidden={tab!=='socials'} className="st-form-grid">{['facebook','x','youtube','instagram','linkedin'].map(k=>field(k,k==='x'?'X / Twitter':k[0].toUpperCase()+k.slice(1),'url'))}</div>
 <Message error={error}/><div className="st-dialog-footer"><Action disabled={busy} onClick={onClose}>{readOnly?'Close':'Cancel'}</Action>{!readOnly&&<Action primary type="submit" disabled={busy}>{busy?'Saving…':'Save Salesman'}</Action>}</div></form></div></Modal>;
}
// Affiliate links modal: campaign links (existing) + per-product tracking links.
function LinksModal({salespersonId}:{salespersonId:string}){
 const [tab,setTab]=useState('products');
 return <div className="st-dialog"><Tabs value={tab} onChange={setTab} tabs={[{id:'products',label:'Product links'},{id:'campaigns',label:'Campaign links'}]}/>
  {tab==='products'?<ProductLinks salespersonId={salespersonId}/>:<SalesmanLinks salespersonId={salespersonId}/>}</div>;
}
