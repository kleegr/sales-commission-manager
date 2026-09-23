import {useState} from 'react';
import {Button,Modal,Field,Select,Textarea} from '../ui';
import {useAuth} from '../../store/AuthContext';
import {ROLE_LABEL,type Role} from '../../lib/roles';
import type {CompanyUser} from '../../lib/company-users';
import {trackerPost} from '../../lib/tracker-client';

const descriptions:Record<string,string>={owner:'Full administrative access, including agency workspace visibility where connected. Only an owner can grant this role.',admin:'Manage company users, products, proposals, commissions, payouts and settings.',sales_manager:'View and manage assigned salesmen and their proposals. Assign their team separately under Salesman → Teams & managers.',salesperson:'Access their own sales portal. A salesman profile is created or linked automatically.',affiliate:'Access their own affiliate portal and commission activity.',partner:'Access their own partner portal and commission activity.',accountant:'Read-only access to accounting operations.',none:'Disable app access and end their current sessions. Salesman enrollment and financial history are preserved.'};
export function UserAccessEditor({person,enrollOnly,onClose,onSaved}:{person:CompanyUser;enrollOnly:boolean;onClose:()=>void;onSaved:()=>void}){
  const {user}=useAuth();
  const [role,setRole]=useState(person.login?.status==='active'?person.login.role||'none':'none');
  const [reason,setReason]=useState(''),[confirmed,setConfirmed]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
  async function save(){setBusy(true);setError('');try{
    const identity=person.login?{userId:person.login.id}:{externalId:person.directory?.external_id};
    await trackerPost(enrollOnly?'enrollCompanyUser':'changeCompanyUserRole',{...identity,role,reason,expectedRole:person.login?.role||'none',expectedStatus:person.login?.status||'none'});
    onSaved();
  }catch(e){setError(e instanceof Error?e.message:'The user could not be updated.');}finally{setBusy(false);}}
  return <Modal open title={`${enrollOnly?'Make salesman':'Change user role'} · ${person.name}`} onClose={()=>{if(!busy)onClose();}} footer={<div className="ps-actions"><Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button><Button onClick={()=>void save()} disabled={busy||(!enrollOnly&&(!reason.trim()||!confirmed||(!person.login&&role==='none')))}>{busy?'Saving…':enrollOnly?'Add as salesman':'Save role'}</Button></div>}>
    <div className="proposal-fields">
      <p>{person.email||'No email provided'}</p>
      {enrollOnly?<p>This adds an active salesman profile without changing their user role. Commission plans and campaign assignments are configured separately.</p>:<>
        <Field label="User role"><Select aria-label="User role" value={role} onChange={e=>{setRole(e.target.value);setConfirmed(false);}}><option value="none">No app access</option>{Object.keys(ROLE_LABEL).map(r=><option key={r} value={r} disabled={r==='owner'&&user?.role!=='owner'}>{r==='owner'?'Owner':r==='salesperson'?'Salesman':ROLE_LABEL[r as Role]}</option>)}</Select></Field>
        <p className="proposal-caption">{descriptions[role]}</p><p className="proposal-caption">An Owner, Admin or other user can also be a salesman. Keep their user role and use Make salesman in the Users list to add salesman enrollment. Changing this dropdown to Salesman replaces their current access role.</p>
        {!person.login&&<p className="proposal-caption">This connected user will sign in through Kleeger / Smart Productivity. No password or invitation email is created.</p>}
        <Field label="Reason for change"><Textarea aria-label="Reason for change" rows={3} value={reason} onChange={e=>setReason(e.target.value)} placeholder="Why is this access needed?"/></Field>
        <label className="flex items-start gap-2"><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/><span>I confirm this app access change for {person.name}.</span></label>
        <p className="proposal-caption">The change is recorded in the audit history. Their existing sessions will end; the saved role applies on their next sign-in and persists across future launches. Kleeger permissions are unchanged.</p>
      </>}
      {error&&<p role="alert" className="proposal-error">{error}</p>}
    </div>
  </Modal>;
}
