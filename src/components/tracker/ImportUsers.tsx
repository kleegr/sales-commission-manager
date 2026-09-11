import {useState} from 'react';
import {DirectorySync} from '../DirectorySync';
import {Modal} from '../ui';
import {trackerPost} from '../../lib/tracker-client';
import {Action,Empty,Message,Pager,SearchBox,useRemote} from './Experience';

export default function ImportUsers({onClose,onSaved}:{onClose:()=>void;onSaved:(count:number)=>void}){
 const [q,setQ]=useState(''),[page,setPage]=useState(1),[revision,setRevision]=useState(0),[selected,setSelected]=useState<string[]>([]),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const users=useRemote('directory',{q,page:String(page),limit:'10',sort:'name'},revision);
 return <Modal open title="Import Salesmen from Users" size="lg" onClose={()=>{if(!busy)onClose();}}><div className="st-dialog">
 <p className="st-help">Choose the sub-account users who will sell for you. Importing adds a salesman profile; it does not grant app access or change their GHL permissions. Existing salesmen are marked below.</p>
 <DirectorySync resource="team" onSynced={()=>setRevision(n=>n+1)}/>
 <div className="st-toolbar"><SearchBox value={q} onChange={v=>{setQ(v);setPage(1);}} placeholder="Search sub-account users"/><span>{selected.length} selected · maximum 100</span></div>
 <Message error={error||users.error}/>
 {users.loading?<p role="status">Loading sub-account users…</p>:users.data?.rows.length?<div className="st-table-wrap"><table className="st-table"><thead><tr><th>Select</th><th>Name</th><th>Email</th><th>Salesman status</th></tr></thead><tbody>{users.data.rows.map((r:any)=><tr key={r.external_id}><td><input type="checkbox" aria-label={`Import ${r.name}`} disabled={busy||!r.active||!!r.participant_id||selected.length>=100&&!selected.includes(r.external_id)} checked={selected.includes(r.external_id)} onChange={e=>setSelected(v=>e.target.checked?[...v,r.external_id]:v.filter(id=>id!==r.external_id))}/></td><td>{r.name}</td><td>{r.email||'No email'}</td><td>{r.participant_id?'Already a salesman':r.active?'Available to import':'Inactive in GHL'}</td></tr>)}</tbody></table></div>:<Empty title="No matching users" description="Refresh connected users above, or change your search."/>}
 <Pager total={users.data?.total||0} page={page} limit={10} onPage={setPage}/>
 <div className="st-dialog-footer"><Action disabled={busy} onClick={onClose}>Cancel</Action><Action primary disabled={busy||!selected.length} onClick={async()=>{setBusy(true);setError('');try{const result=await trackerPost('enroll',{externalIds:selected,role:'salesperson'});onSaved(result.ids.length);}catch(e){setError((e as Error).message);}finally{setBusy(false);}}}>{busy?'Importing…':`Import ${selected.length} Salesmen`}</Action></div>
 </div></Modal>;
}
