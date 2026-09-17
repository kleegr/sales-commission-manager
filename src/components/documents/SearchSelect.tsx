import {useEffect,useId,useRef,useState} from 'react';
import {Check,ChevronDown,Search} from 'lucide-react';

export interface SearchOption{value:string;label:string;detail?:string}
/** An in-page selector: opens below the field, with bounded scrolling and keyboard navigation. */
export function SearchSelect({label,value,options,onChange,disabled=false,placeholder='Choose an option…'}:{label:string;value:string;options:SearchOption[];onChange:(value:string)=>void;disabled?:boolean;placeholder?:string}){
 const [open,setOpen]=useState(false),[query,setQuery]=useState('');const id=useId(),root=useRef<HTMLDivElement>(null),input=useRef<HTMLInputElement>(null),trigger=useRef<HTMLButtonElement>(null);
 const selected=options.find(o=>o.value===value),matches=options.filter(o=>`${o.label} ${o.detail||''}`.toLowerCase().includes(query.trim().toLowerCase()));
 useEffect(()=>{if(open)input.current?.focus();},[open]);
 function close(){setOpen(false);trigger.current?.focus();}
 return <div className="proposal-search-select" ref={root} onBlur={e=>{if(!e.currentTarget.contains(e.relatedTarget as Node))setOpen(false);}} onKeyDown={e=>{if(e.key==='Escape'){e.preventDefault();close();}if(open&&['ArrowDown','ArrowUp'].includes(e.key)){e.preventDefault();const nodes=Array.from(root.current?.querySelectorAll<HTMLButtonElement>('[data-choice]')||[]);const at=nodes.indexOf(document.activeElement as HTMLButtonElement);nodes[Math.max(0,Math.min(nodes.length-1,at+(e.key==='ArrowDown'?1:-1)))]?.focus();}}}>
 <button ref={trigger} type="button" className="proposal-select-trigger" aria-label={label} aria-expanded={open} aria-controls={id} disabled={disabled} onClick={()=>{setQuery('');setOpen(v=>!v);}}><span>{selected?.label||placeholder}</span><ChevronDown size={15}/></button>
 {open&&!disabled&&<div id={id} className="proposal-select-panel"><div className="proposal-select-search"><Search size={15}/><input ref={input} aria-label={`Search ${label.toLowerCase()}`} placeholder={`Search ${label.toLowerCase()}…`} value={query} onChange={e=>setQuery(e.target.value)}/></div><div className="proposal-select-options" aria-label={`${label} options`}>{matches.length?matches.map(o=><button data-choice key={o.value} type="button" aria-pressed={value===o.value} onClick={()=>{onChange(o.value);close();}}><span><strong>{o.label}</strong>{o.detail&&<small>{o.detail}</small>}</span>{value===o.value&&<Check size={16}/>}</button>):<p role="status">No matches found.</p>}</div><small className="proposal-select-count">{matches.length} options</small></div>}
 </div>;
}
