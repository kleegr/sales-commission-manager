import {useRef,useState} from 'react';
import {ArrowLeft, ArrowRight, Check, FileText, Loader2, Sparkles} from 'lucide-react';
import {Link} from 'react-router-dom';
import {Button, Field, Input} from '../ui';
import {LineItemsEditor, type CatalogProduct} from './LineItems';
import {ProposalPricing} from './ProposalPricing';
import {SearchSelect} from './SearchSelect';
import type {PreviewBranding} from './DocumentPreview';
import {ProposalSheet} from './ProposalSheet';
import {aiGenerate, createClientDocument, updateClientDocument} from '../../lib/resource-client';
import {emptyProspect, type DocRow} from './ProposalShare';
import type {Client, DocumentLineItem, DocumentSection} from '../../types';
import {proposalTotals} from '../../lib/proposal-pricing';

interface Props {
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
  onClose: () => void;
  onSaved: (id:string) => Promise<void>;
}

const steps = ['Client & salesman', 'Products & pricing', 'Summary & terms', 'Review'];
export function ProposalBuilder(p: Props) {
  const editor=useRef<HTMLElement>(null);
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
      if(items.some(i=>BigInt(i.unitPriceMinor)<BigInt(p.products.find(x=>x.id===i.productId)?.price_minor||'0')))return 'A price is below its catalog minimum.';
    }
    if(index===2&&!terms.trim())return 'Add the terms your client will approve.';
    return '';
  }
  function next(){const invalid=editor.current?.querySelector<HTMLInputElement>('input:invalid');if(invalid){invalid.reportValidity();return;}const message=validation(step);setError(message);if(!message)setStep(n=>Math.min(n+1,3));}
  async function save(){
    const invalid=[0,1,2].map(validation).find(Boolean);if(invalid){setError(invalid);return;}
    setBusy(true);setError('');
    try{
      const result=p.existing?await updateClientDocument(p.existing.id,{title:resolvedTitle,lineItems:items,campaignId:campaign||null,sections}):await createClientDocument({kind:'proposal',clientId:mode==='client'?clientId:null,prospect:mode==='prospect'?prospect:undefined,salespersonId:seller,title:resolvedTitle,lineItems:items,campaignId:campaign||null,sections});
      await p.onSaved(result.id);
    }catch(e){setError(e instanceof Error?e.message:'Could not save your proposal.');}finally{setBusy(false);}
  }
  async function writeSummary(){setAiBusy(true);setError('');try{
    const result=await aiGenerate({kind:'proposal',target:'section',sectionType:'solution',clientId:mode==='client'?clientId:null,instructions:`Write a concise proposal introduction only. Do not invent features, prices, savings, timelines or promises. Client: ${recipient}. Requirements: ${requirements}. Selected catalog items: ${JSON.stringify(items.map(i=>({name:i.name,description:i.description,quantity:i.qty})))}. Preserve these facts.`});
    setSummary(result.sections.map(s=>s.content).join('\n\n'));
  }catch(e){setError(e instanceof Error?e.message:'AI drafting is unavailable. You can write the summary yourself.');}finally{setAiBusy(false);}}
  return <div className="proposal-builder">
    <header className="proposal-builder-header"><div><button className="proposal-back" onClick={p.onClose} disabled={busy}><ArrowLeft size={16}/> All proposals</button><h1>{p.existing?'Edit proposal':'Create a proposal'}</h1><p>Select products from your catalog, review the price, and prepare a proposal your client can approve.</p></div><span className="proposal-draft">Draft · not shared</span></header>
    <nav className="proposal-steps" aria-label="Proposal steps">{steps.map((label,index)=><button key={label} aria-current={step===index?'step':undefined} disabled={index>step||busy} onClick={()=>{setStep(index);setError('');}}><span>{index<step?<Check size={16}/>:index+1}</span>{label}</button>)}</nav>
    {(error||p.loadError)&&<p role="alert" className="proposal-error">{error||p.loadError}</p>}
    {!p.businessName?.trim()&&<p role="status" className="proposal-error">Your business name is missing. Add it in Proposals → Business Setup → Business name before using AI drafting. You can still save this proposal as a draft.</p>}
    <div className="proposal-builder-grid"><section className="proposal-editor" ref={editor}>
      <h2>{steps[step]}</h2>
      {step===0&&<div className="proposal-fields">
        <Field label="Proposal title"><Input value={title} onChange={e=>setTitle(e.target.value)} placeholder={resolvedTitle}/></Field>
        {!p.existing&&<div className="st-mode-toggle"><button type="button" className={mode==='client'?'is-active':''} onClick={()=>setMode('client')}>Existing client</button><button type="button" className={mode==='prospect'?'is-active':''} onClick={()=>setMode('prospect')}>New client</button></div>}
        {p.existing?<p>Prepared for <strong>{recipient}</strong>. Client and ownership remain attached to this draft.</p>:mode==='client'?<Field label="Client"><SearchSelect label="Client" value={clientId} placeholder="Choose a client…" options={p.clients.map(c=>({value:c.id,label:c.companyName||c.contactName,detail:[c.companyName?c.contactName:'',c.email].filter(Boolean).join(' · ')}))} onChange={value=>{setClientId(value);const c=p.clients.find(c=>c.id===value);setSeller(c?.salespersonId||p.salespersonId||'');}}/></Field>:<div className="proposal-fields-two">{(['name','email','company','phone'] as const).map(key=><Field key={key} label={{name:'Contact name *',email:'Email *',company:'Company',phone:'Phone'}[key]}><Input type={key==='email'?'email':'text'} value={prospect[key]} onChange={e=>setProspect({...prospect,[key]:e.target.value})}/></Field>)}</div>}
        <Field label="Responsible salesman" hint="The proposal, client approval and resulting sales stay connected to this person."><SearchSelect label="Responsible salesman" disabled={p.self||!!p.existing||(mode==='client'&&!!client?.salespersonId)} value={seller} placeholder={seller?'Assigned salesman (unavailable for new assignments)':'Choose a salesman…'} options={p.salespeople.map(s=>({value:s.id,label:s.name,detail:s.email}))} onChange={setSeller}/><p className="proposal-caption">Only active, enrolled salesmen appear here. Add or import salesmen from the Salesman page.</p></Field>
      </div>}
      {step===1&&<><p className="proposal-caption">Names, descriptions and billing details come from Products. Edit the quantity and selling price here.</p><LineItemsEditor items={items} onChange={setItems} products={p.products} currency={p.currency} digits={p.digits} loading={p.loading} showSummary={false}/><Link className="proposal-catalog-link" to="/products">Manage your product catalog →</Link><details className="proposal-advanced"><summary>Commission campaign (optional)</summary><Field label="Campaign" hint="Use a campaign when it defines the commission plan for these products."><SearchSelect label="Campaign" value={campaign} onChange={setCampaign} options={[{value:'',label:'Salesman’s default commission plan'},...p.campaigns.map(c=>({value:c.id,label:c.name}))]}/></Field></details></>}
      {step===2&&<div className="proposal-fields"><Field label="What does this client need?"><textarea value={requirements} onChange={e=>setRequirements(e.target.value)} rows={3} placeholder="Describe their goals and what you will deliver."/></Field><div className="proposal-inline"><h3>Proposal summary</h3><Button variant="secondary" disabled={!p.aiReady||!p.businessName?.trim()||aiBusy} onClick={()=>void writeSummary()}>{aiBusy?<Loader2 size={16} className="animate-spin"/>:<Sparkles size={16}/>} Draft with AI</Button></div>{!p.aiReady&&<p className="proposal-caption">AI drafting becomes available once OpenAI is configured. You can write and save your proposal now.</p>}<textarea aria-label="Proposal summary" rows={6} value={summary||defaultSummary} onChange={e=>setSummary(e.target.value)}/><Field label="Terms & next steps"><textarea rows={5} value={terms} onChange={e=>setTerms(e.target.value)}/></Field></div>}
      {step===3&&<div className="proposal-review"><p className="proposal-caption">Prepared for <strong>{recipient}</strong> · {p.salespeople.find(s=>s.id===seller)?.name}</p><ProposalSheet title={resolvedTitle} sections={sections} branding={p.branding} items={items} currency={p.currency} digits={p.digits} recipient={{name:recipient,company:''}} preparedBy={p.salespeople.find(s=>s.id===seller)?.name}/></div>}
      <footer className="proposal-builder-footer"><Button variant="secondary" disabled={busy} onClick={()=>step?setStep(step-1):p.onClose()}>{step?'Back':'Cancel'}</Button>{step<3?<Button onClick={next}>Continue <ArrowRight size={16}/></Button>:<Button disabled={busy||aiBusy} onClick={()=>void save()}>{busy?<Loader2 size={16} className="animate-spin"/>:<FileText size={16}/>}Save proposal</Button>}</footer>
    </section><aside className="proposal-builder-summary"><span className="proposal-eyebrow">LIVE PRICE SUMMARY</span><h2>{recipient||'Your client'}</h2><p>{items.filter(i=>i.productId).length} products selected</p><ProposalPricing items={items.filter(i=>i.productId)} currency={p.currency} digits={p.digits} detailed={false}/><div className="proposal-tracking-note"><Check size={18}/><p>Tracked in Sales Tracker<br/><small>Shared → Viewed → Approved → Payment. Commissions follow verified payments.</small></p></div>{proposalTotals(items).firstPayment===0n&&<p className="proposal-caption">Choose your products to calculate the investment.</p>}</aside></div>
  </div>;
}
