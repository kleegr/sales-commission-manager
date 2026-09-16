// ============================================================================
// PRODUCTS — the product catalog (admin)
//
// The first step of the sell -> commission -> pay flow: what your team sells.
// Add or sync products from GoHighLevel, set a price floor, then assign each
// product to the salespeople allowed to sell it. Assigned products power the
// document line-item builder and per-product commission structures.
//
// Reads:  products {q,category,status,page,limit}, productAssignments {productId|salespersonId}, people
// Writes: saveProduct, deleteProduct, syncGhlProducts, assignProducts
// GHL-native pricing (minor units); no Stripe.
// ============================================================================
import {useMemo,useState} from 'react';
import {Plus,RefreshCw,Users,Package,Filter} from 'lucide-react';
import {Modal} from '../../components/ui';
import {DecimalInput} from '../../components/TrackerForm';
import {useTracker} from '../../components/TrackerGate';
import {trackerGet,trackerPost,trackerCSV} from '../../lib/tracker-client';
import {displayMinor} from '../../lib/exact-commission';
import {Action,Badge,Empty,ExportIcon,Field,Header,Message,Pager,SearchBox,Steps,Tabs,useRemote} from '../../components/tracker/Experience';
import ProductLinks from '../../components/tracker/ProductLinks';
const BILLING:Record<string,string>={one_time:'One-time',recurring:'Recurring',setup:'Setup fee'};
export default function Products(){
 const {workspace}=useTracker(),currency=workspace?.currency||'USD',digits=workspace?.payout_terms?.minorDigits??2;
 const [tab,setTab]=useState('catalog');
 const [q,setQ]=useState(''),[category,setCategory]=useState(''),[status,setStatus]=useState(''),[page,setPage]=useState(1),[limit,setLimit]=useState(25),[revision,setRevision]=useState(0);
 const [dialog,setDialog]=useState(false),[edit,setEdit]=useState<any>(null),[sellersFor,setSellersFor]=useState<any>(null),[notice,setNotice]=useState(''),[error,setError]=useState(''),[syncing,setSyncing]=useState(false);
 const state=useRemote('products',{q,category,status,page:String(page),limit:String(limit)},revision);
 const money=(v:string)=>displayMinor(v||'0',currency,digits);
 // Category options: union of what's on this page with the active selection, so the filter always shows the current choice.
 const categories=useMemo(()=>{const s=new Set<string>();(state.data?.rows||[]).forEach((r:any)=>{if(r.category)s.add(r.category);});if(category)s.add(category);return [...s].sort();},[state.data,category]);
 async function sync(){setSyncing(true);setError('');setNotice('');try{const r=await trackerPost('syncGhlProducts',{});setNotice(`Sync complete — ${r.created} added, ${r.updated} updated${r.total?` (${r.total} in GoHighLevel)`:''}.`);setRevision(n=>n+1);}catch(e){setError((e as Error).message);}finally{setSyncing(false);}}
 async function archive(r:any){if(!window.confirm(`Archive "${r.name}"? It stays on past documents but can no longer be added to new ones.`))return;setError('');try{await trackerPost('deleteProduct',{id:r.id});setNotice(`${r.name} archived.`);setRevision(n=>n+1);}catch(e){setError((e as Error).message);}}
 return <div className="st-page"><Header title="Products" description="What your team sells. Add or sync your products, set each price, then assign them to salespeople.">
  <Action onClick={()=>void trackerCSV('products',{q,category,status}).catch(e=>setError(e.message))}><ExportIcon/>Export</Action>
  <Action disabled={syncing} onClick={()=>void sync()}><RefreshCw size={16}/>{syncing?'Syncing…':'Sync from GHL'}</Action>
  <Action primary onClick={()=>{setEdit(null);setDialog(true);}}><Plus size={16}/>Add Product</Action></Header>
 <Tabs value={tab} onChange={setTab} tabs={[{id:'catalog',label:'Catalog'},{id:'bySalesperson',label:'Who sells what'}]}/>
 <Message error={error||state.error} notice={notice}/>
 {tab==='bySalesperson'?<AssignBySalesperson currency={currency} digits={digits} onNotice={m=>setNotice(m)} onError={m=>setError(m)}/>:<section className="st-panel">
  <div className="st-toolbar"><SearchBox value={q} onChange={v=>{setQ(v);setPage(1);}} placeholder="Search products by name, SKU or category"/>
   <label className="st-filter"><Filter size={16}/><select aria-label="Category" value={category} onChange={e=>{setCategory(e.target.value);setPage(1);}}><option value="">All categories</option>{categories.map(c=><option key={c} value={c}>{c}</option>)}</select></label>
   <label className="st-filter"><select aria-label="Status" value={status} onChange={e=>{setStatus(e.target.value);setPage(1);}}><option value="">Active & inactive</option><option value="active">Active</option><option value="inactive">Inactive</option><option value="archived">Archived</option></select></label></div>
  {state.loading?<p className="st-loading" role="status">Loading products…</p>:state.data?.rows?.length?<div className="st-table-wrap"><table className="st-table"><thead><tr>{['Product','Category','Price (floor)','Billing','Status','Actions'].map((h,i)=><th key={i} className={h==='Actions'?'st-action-cell':undefined}>{h}</th>)}</tr></thead><tbody>{state.data.rows.map((r:any)=><tr key={r.id}><td><strong>{r.name}</strong>{r.sku&&<small className="st-block st-muted">SKU {r.sku}</small>}{r.ghl_product_id&&<small className="st-block st-muted">From GoHighLevel</small>}</td><td>{r.category||<span className="st-muted">—</span>}</td><td>{money(r.price_minor)}{r.currency&&r.currency!==currency?<small className="st-block st-muted">{r.currency}</small>:null}</td><td>{BILLING[r.billing_kind]||r.billing_kind}{r.recurring_interval&&<small className="st-block st-muted">{r.recurring_interval}</small>}</td><td><Badge value={r.status}/></td><td className="st-action-cell"><div className="st-row-buttons"><Action onClick={()=>setSellersFor(r)}><Users size={15}/>Assign sellers</Action><Action onClick={()=>{setEdit(r);setDialog(true);}}>Edit</Action>{r.status!=='archived'&&<Action onClick={()=>void archive(r)}>Archive</Action>}</div></td></tr>)}</tbody></table></div>:<Empty title={q||category||status?'No matching products':'Add your first product'} description={q||category||status?'Adjust your search or filters.':'Two ways to get started:'}>{!(q||category||status)&&<Steps step={-1} labels={['Add a product manually, or Sync from GoHighLevel','Assign each product to the salespeople who can sell it','Use products on proposals & set per-product commission']}/>}<div className="st-row-buttons"><Action primary onClick={()=>{setEdit(null);setDialog(true);}}><Plus size={16}/>Add Product</Action><Action disabled={syncing} onClick={()=>void sync()}><RefreshCw size={16}/>Sync from GHL</Action></div></Empty>}
  <Pager total={state.data?.total||0} page={page} limit={limit} onPage={setPage} onLimit={n=>{setLimit(n);setPage(1);}} loading={state.loading}/></section>}
 {dialog&&<ProductForm key={edit?.id||'new'} existing={edit} currency={currency} digits={digits} onClose={()=>{setDialog(false);setEdit(null);}} onSaved={()=>{setNotice(edit?'Product updated.':'Product added. Next, assign it to salespeople.');setDialog(false);setEdit(null);setRevision(n=>n+1);}}/>}
 {sellersFor&&<AssignSellers product={sellersFor} onClose={()=>setSellersFor(null)} onSaved={n=>{setSellersFor(null);setNotice(`${sellersFor.name} can be sold by ${n} ${n===1?'salesperson':'salespeople'}.`);}}/>}
 </div>;
}
function ProductForm({existing,currency,digits,onClose,onSaved}:{existing:any;currency:string;digits:number;onClose:()=>void;onSaved:()=>void}){
 const [v,setV]=useState<any>(()=>({name:existing?.name||'',sku:existing?.sku||'',category:existing?.category||'',description:existing?.description||'',priceMinor:String(existing?.price_minor??'0'),billingKind:existing?.billing_kind||'one_time',recurringInterval:existing?.recurring_interval||'month',status:existing?.status||'active',commissionType:existing?.commission_type||'none',commissionPercent:existing?.commission_bps?String(existing.commission_bps/100):'',commissionFlatMinor:String(existing?.commission_flat_minor??'0'),holdDays:String(existing?.commission_hold_days??'0'),destinationUrl:existing?.destination_url||''}));
 const [busy,setBusy]=useState(false),[error,setError]=useState('');
 const set=(k:string,val:any)=>setV((o:any)=>({...o,[k]:val}));
 return <Modal open title={existing?'Edit product':'Add product'} size="lg" onClose={()=>{if(!busy)onClose();}}><form className="st-dialog" onSubmit={async e=>{e.preventDefault();setBusy(true);setError('');try{await trackerPost('saveProduct',{id:existing?.id,name:v.name,sku:v.sku||undefined,category:v.category||undefined,description:v.description||undefined,priceMinor:v.priceMinor,currency,billingKind:v.billingKind,recurringInterval:v.billingKind==='recurring'?v.recurringInterval:undefined,status:v.status,commissionType:v.commissionType,commissionBps:v.commissionType==='percent'?Math.round(Number(v.commissionPercent||'0')*100):0,commissionFlatMinor:v.commissionType==='flat'?v.commissionFlatMinor:'0',holdDays:Number(v.holdDays||'0'),destinationUrl:v.destinationUrl||undefined});onSaved();}catch(e){setError((e as Error).message);}finally{setBusy(false);}}}>
  <p className="st-help">The price you set is the floor — a salesperson can charge this or more on a document, never less.</p>
  <div className="st-form-grid"><Field label="Product name *"><input required value={v.name} onChange={e=>set('name',e.target.value)}/></Field><Field label="SKU"><input value={v.sku} onChange={e=>set('sku',e.target.value)}/></Field>
   <Field label="Category" hint="Groups products in the catalog filter."><input value={v.category} onChange={e=>set('category',e.target.value)} placeholder="e.g. Websites"/></Field>
   <Field label={`Price / floor (${currency}) *`}><DecimalInput className="" label="Price" value={v.priceMinor} digits={digits} onChange={val=>set('priceMinor',val)}/></Field>
   <Field label="Billing"><select value={v.billingKind} onChange={e=>set('billingKind',e.target.value)}><option value="one_time">One-time</option><option value="recurring">Recurring</option><option value="setup">Setup fee</option></select></Field>
   {v.billingKind==='recurring'&&<Field label="Bills every"><select value={v.recurringInterval} onChange={e=>set('recurringInterval',e.target.value)}><option value="day">Day</option><option value="week">Week</option><option value="month">Month</option><option value="year">Year</option></select></Field>}
   <Field label="Status"><select value={v.status} onChange={e=>set('status',e.target.value)}><option value="active">Active</option><option value="inactive">Inactive</option>{existing?.status==='archived'&&<option value="archived">Archived</option>}</select></Field></div>
  <Field label="Description"><textarea value={v.description} onChange={e=>set('description',e.target.value)}/></Field>
  <fieldset className="st-fieldset"><legend>Commission &amp; tracking link</legend>
   <p className="st-help">Set the reward a salesperson earns when this product is sold through their tracking link. Assign the product to a salesperson (below in “Who sells what”) to generate their link.</p>
   <div className="st-form-grid"><Field label="Commission" hint="How the salesperson is paid on a sale."><select value={v.commissionType} onChange={e=>set('commissionType',e.target.value)}><option value="none">No commission</option><option value="percent">Percent of sale</option><option value="flat">Flat amount per sale</option></select></Field>
    {v.commissionType==='percent'&&<Field label="Commission rate (%)" hint="e.g. 10 for 10% of the sale amount."><input type="number" min="0" max="1000" step="0.01" value={v.commissionPercent} onChange={e=>set('commissionPercent',e.target.value)} placeholder="10"/></Field>}
    {v.commissionType==='flat'&&<Field label={`Flat commission (${currency})`} hint="Paid once per sale, regardless of price."><DecimalInput className="" label="Flat commission" value={v.commissionFlatMinor} digits={digits} onChange={val=>set('commissionFlatMinor',val)}/></Field>}
    {v.commissionType!=='none'&&<Field label="Hold before payable (days)" hint="Days after a sale before the commission can be paid out (e.g. 30 for a refund window)."><input type="number" min="0" max="3650" step="1" value={v.holdDays} onChange={e=>set('holdDays',e.target.value)} placeholder="0"/></Field>}</div>
   <Field label="Buy / destination URL" hint="Where the tracking link sends buyers — your GHL order form or checkout page for this product. Leave blank if you only track sales entered manually."><input type="url" value={v.destinationUrl} onChange={e=>set('destinationUrl',e.target.value)} placeholder="https://…"/></Field></fieldset>
  <Message error={error}/><div className="st-dialog-footer"><Action disabled={busy} onClick={onClose}>Cancel</Action><Action primary type="submit" disabled={busy}>{busy?'Saving…':existing?'Save changes':'Add product'}</Action></div></form></Modal>;
}
// Per-product editor: pick which salespeople may sell THIS product. Each toggled
// person's full assignment set is read, this product added/removed, then saved
// atomically with assignProducts (which replaces that person's whole set).
function AssignSellers({product,onClose,onSaved}:{product:any;onClose:()=>void;onSaved:(n:number)=>void}){
 const people=useRemote('people',{limit:'100'}),current=useRemote('productAssignments',{productId:product.id});
 const [sel,setSel]=useState<string[]|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[q,setQ]=useState('');
 const original=useMemo<string[]>(()=>(current.data?.rows||[]).map((r:any)=>String(r.salesperson_id)),[current.data]);
 const selected=sel??original,rows=(people.data?.rows||[]).filter((r:any)=>!q||`${r.name} ${r.email||''}`.toLowerCase().includes(q.toLowerCase()));
 const toggle=(id:string,on:boolean)=>setSel(s=>{const base=s??original;return on?[...new Set([...base,id])]:base.filter(x=>x!==id);});
 async function save(){setBusy(true);setError('');try{const add=selected.filter(id=>!original.includes(id)),remove=original.filter((id:string)=>!selected.includes(id));for(const sp of [...add,...remove]){const cur=(await trackerGet('productAssignments',{salespersonId:sp})).rows.map((r:any)=>r.product_id);const next=add.includes(sp)?[...new Set([...cur,product.id])]:cur.filter((p:string)=>p!==product.id);await trackerPost('assignProducts',{salespersonId:sp,productIds:next});}onSaved(selected.length);}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
 return <Modal open title={`Who can sell ${product.name}`} size="lg" onClose={()=>{if(!busy)onClose();}}><div className="st-dialog">
  <p className="st-help">Only the salespeople you check here can add this product to a proposal, quote or invoice.</p>
  <SearchBox value={q} onChange={setQ} placeholder="Search salespeople"/>
  {people.loading||current.loading?<p className="st-loading" role="status">Loading…</p>:rows.length?<div className="st-check-list">{rows.map((r:any)=><label key={r.id} className="st-check-row"><input type="checkbox" checked={selected.includes(r.id)} onChange={e=>toggle(r.id,e.target.checked)}/><span><strong>{r.name}</strong><small className="st-block st-muted">{r.email||'No email'}</small></span></label>)}</div>:<Empty title="No salespeople yet" description="Add salespeople first, then come back to assign this product."/>}
  <Message error={error||people.error||current.error}/><div className="st-dialog-footer"><span className="st-muted">{selected.length} selected</span><Action disabled={busy} onClick={onClose}>Cancel</Action><Action primary disabled={busy} onClick={()=>void save()}>{busy?'Saving…':'Save'}</Action></div></div></Modal>;
}
// Per-salesperson editor: the whole product set for one person, saved atomically.
function AssignBySalesperson({currency,digits,onNotice,onError}:{currency:string;digits:number;onNotice:(m:string)=>void;onError:(m:string)=>void}){
 const people=useRemote('people',{limit:'100'}),products=useRemote('products',{limit:'100',status:'active'});
 const [spId,setSpId]=useState(''),[sel,setSel]=useState<string[]|null>(null),[busy,setBusy]=useState(false),[loadRev,setLoadRev]=useState(0);
 const current=useRemote('productAssignments',spId?{salespersonId:spId}:{},loadRev);
 const original=useMemo<string[]>(()=>spId?(current.data?.rows||[]).map((r:any)=>String(r.product_id)):[],[current.data,spId]);
 const selected=sel??original,money=(v:string)=>displayMinor(v||'0',currency,digits);
 const toggle=(id:string,on:boolean)=>setSel(s=>{const base=s??original;return on?[...new Set([...base,id])]:base.filter(x=>x!==id);});
 async function save(){setBusy(true);try{await trackerPost('assignProducts',{salespersonId:spId,productIds:selected});onNotice('Product assignments saved.');setSel(null);setLoadRev(n=>n+1);}catch(e){onError((e as Error).message);}finally{setBusy(false);}}
 return <section className="st-panel"><div className="st-toolbar"><label className="st-filter"><Users size={16}/><select aria-label="Salesperson" value={spId} onChange={e=>{setSpId(e.target.value);setSel(null);}}><option value="">Choose a salesperson…</option>{(people.data?.rows||[]).map((r:any)=><option key={r.id} value={r.id}>{r.name}{r.email?` · ${r.email}`:''}</option>)}</select></label></div>
  <p className="st-help">Pick a salesperson, then check every product they are allowed to sell. Products you leave unchecked are blocked on their documents.</p>
  <Message error={people.error||products.error||current.error}/>
  {!spId?<Empty title="Select a salesperson" description="Choose someone above to set the products they can sell."><Package size={22}/></Empty>:current.loading||products.loading?<p className="st-loading" role="status">Loading…</p>:<><div className="st-check-list">{(products.data?.rows||[]).map((r:any)=><label key={r.id} className="st-check-row"><input type="checkbox" checked={selected.includes(r.id)} onChange={e=>toggle(r.id,e.target.checked)}/><span><strong>{r.name}</strong><small className="st-block st-muted">{money(r.price_minor)} · {BILLING[r.billing_kind]||r.billing_kind}</small></span></label>)}</div>{!products.data?.rows?.length&&<Empty title="No active products" description="Add products in the Catalog tab first."/>}<div className="st-dialog-footer"><span className="st-muted">{selected.length} selected</span><Action primary disabled={busy} onClick={()=>void save()}>{busy?'Saving…':'Save assignments'}</Action></div></>}
  {spId&&!current.loading&&<div className="st-panel-inset"><h3 className="st-subhead">This salesperson’s tracking links</h3><ProductLinks key={`${spId}:${loadRev}`} salespersonId={spId}/></div>}</section>;
}
