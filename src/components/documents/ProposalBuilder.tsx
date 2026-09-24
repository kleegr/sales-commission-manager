import {useProposalAutosave} from './useProposalAutosave';
import {ProposalQuality} from './ProposalQuality';
import {productQuote,type ProductPolicy} from '../../lib/proposal-suite';
import {useRef,useState} from 'react';
import {ArrowLeft, ArrowRight, Check, FileText, Loader2, Sparkles} from 'lucide-react';
import {Link} from 'react-router-dom';
import {Button, Field, Input} from '../ui';
import {LineItemsEditor, type CatalogProduct} from './LineItems';
import {ProposalPricing} from './ProposalPricing';
import {SearchSelect} from './SearchSelect';
import type {PreviewBranding} from './DocumentPreview';
import {ProposalSheet} from './ProposalSheet';
import {aiStatus, aiGenerate, createClientDocument, updateClientDocument} from '../../lib/resource-client';
import {emptyProspect, type DocRow} from './ProposalShare';
import type {Client, DocumentLineItem, DocumentSection} from '../../types';
import {proposalTotals} from '../../lib/proposal-pricing';
import {displayMinor} from '../../lib/exact-commission';

interface Props {
  draftKey: string;
  existing?: DocRow | null;
  clients: Client[];
  salespeople: {id:string; name:string; email?:string}[];
  salespersonId?: string | null;
  self: boolean;
  products: CatalogProduct[];
  campaigns: {id:string; name:string}[];
  currency: string;
  digits: number;
  loading: boolean;
  loadError?: string;
  branding: PreviewBranding;
  aiReady: boolean;
  businessName?: string;
  defaultTerms?: string;
  onPolicySaved: (productId:string,policy:ProductPolicy)=>void;
  onClose: () => void;
  onSaved: (id:string) => Promise<void>;
}

const steps = ['Client & salesman', 'Products & pricing', 'Summary & terms', 'Review'];
export function ProposalBuilder(p: Props) {
  const editor=useRef<HTMLElement>(null);
  const [summaryExpanded,setSummaryExpanded]=useState(false);
  const [step,setStep]=useState(0), [busy,setBusy]=useState(false), [aiBusy,setAiBusy]=useState(false), [error,setError]=useState('');
  const [mode,setMode]=useState(p.existing?.prospect?'prospect':p.clients.length?'client':'prospect');
  const [clientId,setClientId]=useState(p.existing?.clientId||'');
  const [prospect,setProspect]=useState(p.existing?.prospect||emptyProspect());
  const [seller,setSeller]=useState(p.existing?.salespersonId||p.salespersonId||'');
  const [title,setTitle]=useState(p.existing?.title||'');
  const [items,setItems]=useState<DocumentLineItem[]>(p.existing?.lineItems||[]);
  const [campaign,setCampaign]=useState(p.existing?.campaignId||'');
  const [summary,setSummary]=useState(p.existing?.sections.find(s=>s.id==='proposal-summary'||s.type==='solution')?.content||'');
  const [terms,setTerms]=useState(p.existing?.sections.find(s=>s.type==='terms')?.content||p.defaultTerms||'Payment is collected separately after approval. Recurring products are billed at the intervals shown. Additional work requires a separate agreement.');
  const [requirements,setRequirements]=useState(p.existing?.sections.find(s=>s.id==='proposal-requirements')?.content||'');
  const [baseUpdatedAt,setBaseUpdatedAt]=useState(p.existing?.updatedAt);
  const savedId=useRef<string|null>(null);
  const draft=useProposalAutosave(p.draftKey,{step,mode,clientId,prospect,seller,title,items,campaign,summary,terms,requirements,baseUpdatedAt},v=>{setStep(Math.min(3,Math.max(0,Number(v.step)||0)));setMode(v.mode||'client');setClientId(v.clientId||'');setProspect(v.prospect||emptyProspect());setSeller(v.seller||'');setTitle(v.title||'');setItems(v.items||[]);setCampaign(v.campaign||'');setSummary(v.summary||'');setTerms(v.terms||'');setRequirements(v.requirements||'');setBaseUpdatedAt(v.baseUpdatedAt);});
  async function close(){try{await draft.flush();p.onClose();}catch(e){setError((e as Error).message);}}
  const client=p.clients.find(c=>c.id===clientId);
  const recipient=mode==='prospect'?(prospect.company||prospect.name):(client?.companyName||client?.contactName||'');
  const resolvedTitle=title.trim()||`Proposal for ${recipient||'your business'}`;
  const defaultSummary=`${p.branding.businessName||'Our team'} proposes the following products and services for ${recipient||'your business'}: ${items.map(i=>i.name).join(', ')||'select products to complete this proposal'}. The quantities, billing intervals and investment are listed below.`;
  const sections:DocumentSection[]=[
    {id:'proposal-summary',type:'solution',title:'Proposal summary',content:summary||defaultSummary},
    ...(requirements.trim()?[{id:'proposal-requirements',type:'scope' as const,title:'Your requirements',content:requirements}]:[]),
    // Keep existing custom sections when moving older proposals into the guided builder.
    ...(p.existing?.sections.filter(s=>!['proposal-summary','proposal-requirements','proposal-terms'].includes(s.id)&&!['solution','terms','pricing'].includes(s.type))||[]),
    {id:'proposal-terms',type:'terms',title:'Terms & next steps',content:terms},
  ];
  function validation(index:number) {
    if(index===0){
      if(mode==='client'&&!clientId)return 'Choose a client.';
      if(mode==='prospect'&&(!prospect.name.trim()||!/^\S+@\S+\.\S+$/.test(prospect.email.trim())))return 'Enter the contact name and a valid email.';
      if(!seller)return 'Choose the salesman who owns this proposal.';
      if(!p.existing&&!p.salespeople.some(s=>s.id===seller))return 'This client’s salesman is not active or enrolled. Ask an administrator to review their assignment on the Salesman page.';
    }
    if(index===1){
      if(p.loading)return 'Wait for your catalog to finish loading.';
      if(p.loadError)return 'Your product catalog could not be loaded. Return to proposals and try again.';
      if(!items.length||items.some(i=>!i.productId))return 'Add at least one product and complete each product selection.';
      if(items.some(i=>!Number.isSafeInteger(i.qty)||i.qty<1||!/^\d+$/.test(i.unitPriceMinor)))return 'Enter a whole quantity and a valid price for every product.';
      if(new Set(items.map(i=>i.productId)).size!==items.length)return 'Combine duplicate products into one quantity.';
      for(const item of items){const product=p.products.find(x=>x.id===item.productId);if(!product)return 'A selected product is no longer available.';const quote=productQuote(product,item.qty,items,p.products);if(quote.error)return quote.error;if(BigInt(item.unitPriceMinor)<BigInt(quote.floorMinor))return 'A price is below its configured minimum.';}
    }
    if(index===2&&!terms.trim())return 'Add the terms your client will approve.';
    return '';
  }
  function next(){const invalid=editor.current?.querySelector<HTMLInputElement>('input:invalid');if(invalid){invalid.reportValidity();return;}const message=validation(step);setError(message);if(!message)setStep(n=>Math.min(n+1,3));}
  async function save(){
    const invalid=[0,1,2].map(validation).find(Boolean);if(invalid){setError(invalid);return;}
    setBusy(true);setError('');
    try{
      await draft.flush();
      const result=savedId.current?{id:savedId.current}:p.existing?await updateClientDocument(p.existing.id,{expectedUpdatedAt:baseUpdatedAt,title:resolvedTitle,lineItems:items,campaignId:campaign||null,sections}):await createClientDocument({kind:'proposal',clientId:mode==='client'?clientId:null,prospect:mode==='prospect'?prospect:undefined,salespersonId:seller,title:resolvedTitle,lineItems:items,campaignId:campaign||null,sections});
      savedId.current=result.id;
      await draft.clear();
      await p.onSaved(result.id);
    }catch(e){setError(e instanceof Error?e.message:'Could not save your proposal.');}finally{setBusy(false);}
  }
  async function writeSummary(){setAiBusy(true);setError('');try{
    const status=await aiStatus();
    if(!status.configured)throw new Error("AI drafting is not configured for this deployment. Ask an administrator to check OPENAI_API_KEY in Production and redeploy.");
    const result=await aiGenerate({kind:'proposal',target:'section',sectionType:'solution',clientId:mode==='client'?clientId:null,instructions:`Write a concise proposal introduction only. Do not invent features, prices, savings, timelines or promises. Client: ${recipient}. Requirements: ${requirements}. Selected catalog items: ${JSON.stringify(items.map(i=>({name:i.name,description:i.description,quantity:i.qty})))}. Preserve these facts.`});
    setSummary(result.sections.map(s=>s.content).join('\n\n'));
  }catch(e){setError(e instanceof Error?e.message:'AI drafting is unavailable. You can write the summary yourself.');}finally{setAiBusy(false);}}
  if(!draft.ready)return <p role="status">Loading your saved proposal draft…</p>;
  return <div className="proposal-builder">
    <header className="proposal-builder-header"><div><button className="proposal-back" onClick={()=>void close()} disabled={busy}><ArrowLeft size={16}/> All proposals</button><h1>{p.existing?'Edit proposal':'Create a proposal'}</h1><p>Select products from your catalog, review the price, and prepare a proposal your client can approve.</p></div><span className="proposal-draft">{draft.status}</span></header>
    <nav className="proposal-steps" aria-label="Proposal steps">{steps.map((label,index)=><button key={label} aria-current={step===index?'step':undefined} disabled={index>step||busy} onClick={()=>{setStep(index);setError('');}}><span>{index<step?<Check size={16}/>:index+1}</span>{label}</button>)}</nav>
    {(error||p.loadError||draft.error)&&<p role="alert" className="proposal-error">{error||p.loadError||draft.error}</p>}
    {!p.businessName?.trim()&&<p role="status" className="proposal-error">Your business name is missing. Add it in Proposals → Business Setup → Business name before using AI drafting. You can still save this proposal as a draft.</p>}
    <div className={`proposal-builder-grid${summaryExpanded?' summary-expanded':''}`}><section className="proposal-editor" ref={editor}>
      <h2>{steps[step]}</h2><div key={step} className="proposal-editor-scroll" role="region" aria-label={`${steps[step]} editor`} tabIndex={0}>
      {step===0&&<div className="proposal-fields">
        <Field label="Proposal title"><Input value={title} onChange={e=>setTitle(e.target.value)} placeholder={resolvedTitle}/></Field>
        {!p.existing&&<div className="st-mode-toggle"><button type="button" className={mode==='client'?'is-active':''} onClick={()=>setMode('client')}>Existing client</button><button type="button" className={mode==='prospect'?'is-active':''} onClick={()=>setMode('prospect')}>New client</button></div>}
        {p.existing?<p>Prepared for <strong>{recipient}</strong>. Client and ownership remain attached to this draft.</p>:mode==='client'?<Field label="Client"><SearchSelect label="Client" value={clientId} placeholder="Choose a client…" options={p.clients.map(c=>({value:c.id,label:c.companyName||c.contactName,detail:[c.companyName?c.contactName:'',c.email].filter(Boolean).join(' · ')}))} onChange={value=>{setClientId(value);const c=p.clients.find(c=>c.id===value);setSeller(c?.salespersonId||p.salespersonId||'');}}/></Field>:<div className="proposal-fields-two">{(['name','email','company','phone'] as const).map(key=><Field key={key} label={{name:'Contact name *',email:'Email *',company:'Company',phone:'Phone'}[key]}><Input type={key==='email'?'email':'text'} value={prospect[key]} onChange={e=>setProspect({...prospect,[key]:e.target.value})}/></Field>)}</div>}
        <Field label="Responsible salesman" hint="The proposal, client approval and resulting sales stay connected to this person."><SearchSelect label="Responsible salesman" disabled={p.self||!!p.existing||(mode==='client'&&!!client?.salespersonId)} value={seller} placeholder={seller?'Assigned salesman (unavailable for new assignments)':'Choose a salesman…'} options={p.salespeople.map(s=>({value:s.id,label:s.name,detail:s.email}))} onChange={setSeller}/><p className="proposal-caption">Only active, enrolled salesmen appear here. Add or import salesmen from the Salesman page.</p></Field>
      </div>}
      {step===1&&<><p className="proposal-caption">Names, descriptions and billing details come from Products. Edit the quantity and selling price here.</p><LineItemsEditor items={items} onChange={next=>{setItems(next);setError('');}} products={p.products} currency={p.currency} digits={p.digits} loading={p.loading} showSummary={false} onPolicySaved={p.onPolicySaved}/><Link className="proposal-catalog-link" to="/products">Manage your product catalog →</Link><details className="proposal-advanced"><summary>Commission campaign (optional)</summary><Field label="Campaign" hint="Use a campaign when it defines the commission plan for these products."><SearchSelect label="Campaign" value={campaign} onChange={setCampaign} options={[{value:'',label:'Salesman’s default commission plan'},...p.campaigns.map(c=>({value:c.id,label:c.name}))]}/></Field></details></>}
      {step===2&&<div className="proposal-fields"><Field label="What does this client need?"><textarea value={requirements} onChange={e=>setRequirements(e.target.value)} rows={3} placeholder="Describe their goals and what you will deliver."/></Field><div className="proposal-inline"><h3>Proposal summary</h3><Button variant="secondary" disabled={!p.businessName?.trim()||aiBusy} onClick={()=>void writeSummary()}>{aiBusy?<Loader2 size={16} className="animate-spin"/>:<Sparkles size={16}/>} Draft with AI</Button></div>{!p.aiReady&&<p className="proposal-caption">Click Draft with AI to check availability and generate a summary from your products and client requirements.</p>}<textarea aria-label="Proposal summary" rows={6} value={summary||defaultSummary} onChange={e=>setSummary(e.target.value)}/><Field label="Terms & next steps"><textarea rows={5} value={terms} onChange={e=>setTerms(e.target.value)}/></Field></div>}
      {step===3&&<div className="proposal-review"><p className="proposal-caption">Prepared for <strong>{recipient}</strong> · {p.salespeople.find(s=>s.id===seller)?.name}</p><ProposalSheet title={resolvedTitle} sections={sections} branding={p.branding} items={items} currency={p.currency} digits={p.digits} recipient={{name:recipient,company:''}} preparedBy={p.salespeople.find(s=>s.id===seller)?.name}/><ProposalQuality title={resolvedTitle} items={items} sections={sections} clientId={mode==='client'?clientId:null}/></div>}
      </div><footer className="proposal-builder-footer"><Button variant="secondary" disabled={busy} onClick={()=>step?setStep(step-1):void close()}>{step?'Back':'Cancel'}</Button>{step<3?<Button onClick={next}>Continue <ArrowRight size={16}/></Button>:<Button disabled={busy||aiBusy} onClick={()=>void save()}>{busy?<Loader2 size={16} className="animate-spin"/>:<FileText size={16}/>}Save & open workspace</Button>}</footer>
    </section><aside className="proposal-builder-summary"><button type="button" className="proposal-summary-toggle" aria-expanded={summaryExpanded} onClick={()=>setSummaryExpanded(value=>!value)}>{summaryExpanded?'Hide price details':'View price details'}</button><span className="proposal-eyebrow">YOUR PROPOSAL · LIVE SUMMARY</span><h2>{recipient||'Your client'}</h2><p>{items.filter(i=>i.productId).length} products selected · Updates instantly</p><div className="proposal-live-total" role="status" aria-live="polite" aria-atomic="true"><span>First payment</span><strong>{displayMinor(proposalTotals(items.filter(i=>i.productId)).firstPayment.toString(),p.currency,p.digits)}</strong><small>One-time charges + first recurring period</small></div><div className="proposal-selection-context">{seller&&<p><span>Salesman</span><strong>{p.salespeople.find(s=>s.id===seller)?.name||"Assigned salesman"}</strong></p>}{campaign&&<p><span>Campaign</span><strong>{p.campaigns.find(c=>c.id===campaign)?.name||"Selected campaign"}</strong></p>}</div>{!items.some(i=>i.productId)&&<p className="proposal-summary-empty">Select a product to see its details, quantity and price here.</p>}<ProposalPricing items={items.filter(i=>i.productId)} currency={p.currency} digits={p.digits} detailed={true}/><div className="proposal-tracking-note"><Check size={18}/><p>Tracked in Kleeger<br/><small>Shared → Viewed → Approved → Payment. Commissions follow verified payments.</small></p></div>{proposalTotals(items).firstPayment===0n&&<p className="proposal-caption">Choose your products to calculate the investment.</p>}</aside></div>
  </div>;
}
