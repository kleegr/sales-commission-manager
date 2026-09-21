import {useEffect,useState} from 'react';
import {Field,Input} from '../ui';
import {DecimalInput} from '../TrackerForm';
import {displayMinor} from '../../lib/exact-commission';
import {proposalTotals} from '../../lib/proposal-pricing';
import {valueEstimate,type ProposalPackage,type ValueAssumptions} from '../../lib/proposal-suite';

export function ProposalDecision({packages,selected,onSelect,locked,currency,digits}:{packages:ProposalPackage[];selected:string;onSelect:(id:string)=>void;locked:boolean;currency:string;digits:number}){
  if(!packages.length)return null;
  return <section className="ps-client-section"><span className="proposal-eyebrow">YOUR OPTIONS</span><h2>Choose the right fit</h2><p>Choose a package to update the proposal below. Your selected products and price are recorded with your approval.</p><div className="ps-package-grid">{packages.map(p=><label key={p.id} className={`ps-package-choice ${selected===p.id?'selected':''}`}><div><input type="radio" name="proposal-package" value={p.id} checked={selected===p.id} disabled={locked} onChange={()=>onSelect(p.id)}/><strong>{p.name}</strong></div><p>{p.description}</p><b>{displayMinor(proposalTotals(p.items).firstPayment.toString(),currency,digits)}</b><small>First payment</small><ul>{p.items.map(i=><li key={i.productId}>{i.qty} × {i.name}{i.includedQty?` (${i.includedQty} included)`:''}</li>)}</ul></label>)}</div></section>;
}
export function ProposalValue({assumptions,currency,digits,monthlyMinor}:{assumptions:ValueAssumptions;currency:string;digits:number;monthlyMinor:string}){
  const [value,setValue]=useState(assumptions);useEffect(()=>setValue(assumptions),[assumptions]);
  const estimate=valueEstimate(value,monthlyMinor),money=(v:string)=>displayMinor(v,currency,digits);
  return <section className="ps-client-section"><span className="proposal-eyebrow">ILLUSTRATIVE VALUE</span><h2>Explore the potential impact</h2><p>Change these assumptions to explore a scenario. This calculation is an estimate, not a guaranteed result or a change to the agreed price.</p><div className="ps-stat-grid"><div><span>Potential monthly benefit</span><strong>{money(estimate.monthlyBenefitMinor)}</strong></div><div><span>Potential annual benefit</span><strong>{money(estimate.annualBenefitMinor)}</strong></div></div><div className="proposal-fields-two"><Field label="Hours saved per month"><Input type="number" min={0} max={100000} value={value.hoursPerMonth} onChange={e=>setValue({...value,hoursPerMonth:Number(e.target.value)})}/></Field><Field label={`Estimated value per hour (${currency})`}><DecimalInput label="Estimated hourly value" value={value.hourlyValueMinor} digits={digits} onChange={v=>setValue({...value,hourlyValueMinor:v})}/></Field><Field label="Expected adoption (%)"><Input type="number" min={0} max={100} value={value.adoptionPercent} onChange={e=>setValue({...value,adoptionPercent:Number(e.target.value)})}/></Field></div><small>Calculation: hours saved × value per hour × adoption. Before subscription, setup and other costs.</small></section>;
}
