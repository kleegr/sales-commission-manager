import {useCallback,useEffect,useMemo,useState} from 'react';
import {Link} from 'react-router-dom';
import {RefreshCw,Users} from 'lucide-react';
import {useAuth} from '../../store/AuthContext';
import {UserAccessEditor} from '../../components/tracker/UserAccessEditor';
import {Button} from '../../components/ui';
import {DirectorySync} from '../../components/DirectorySync';
import {trackerGet} from '../../lib/tracker-client';
import {companyUsers,type CompanyIdentity,type CompanyUser} from '../../lib/company-users';
import {ROLE_LABEL,type Role} from '../../lib/roles';

async function allRows(resource:string,signal:AbortSignal):Promise<CompanyIdentity[]> {
  const rows:CompanyIdentity[]=[];
  for(let page=1;page<=1000;page++){
    const result=await trackerGet(resource,{page:String(page),limit:'100'},signal);
    rows.push(...result.rows);
    if(rows.length>=result.total)return rows;
    if(!result.rows.length)throw new Error('The user list could not be loaded completely. Please refresh.');
  }
  throw new Error('This company is too large to display in one directory. Contact support.');
}
const roleLabel=(role?:string)=>role==='owner'?'Owner':role==='salesperson'?'Salesman':ROLE_LABEL[role as Role]||role||'No app access';
export default function CompanyUsers(){
  const {user}=useAuth();
  const [editing,setEditing]=useState<{person:CompanyUser;enrollOnly:boolean}|null>(null),[notice,setNotice]=useState('');
  const [data,setData]=useState<{directory:CompanyIdentity[];logins:CompanyIdentity[];salesmen:CompanyIdentity[]}|null>(null);
  const [revision,setRevision]=useState(0),[loading,setLoading]=useState(true),[error,setError]=useState('');
  const [search,setSearch]=useState(''),[role,setRole]=useState(''),[enrollment,setEnrollment]=useState(''),[page,setPage]=useState(1);
  const refresh=useCallback(()=>setRevision(n=>n+1),[]);
  useEffect(()=>{
    const controller=new AbortController();setLoading(true);setError('');
    Promise.all([allRows('directory',controller.signal),allRows('logins',controller.signal),allRows('people',controller.signal)])
      .then(([directory,logins,salesmen])=>{if(!controller.signal.aborted)setData({directory,logins,salesmen});})
      .catch(e=>{if(!controller.signal.aborted)setError(e.message);})
      .finally(()=>{if(!controller.signal.aborted)setLoading(false);});
    return()=>controller.abort();
  },[revision]);
  const users=useMemo(()=>data?companyUsers(data.directory,data.logins,data.salesmen):[],[data]);
  const filtered=users.filter(u=>(!search.trim()||`${u.name} ${u.email}`.toLowerCase().includes(search.trim().toLowerCase()))&&(!role||(role==='none'?!u.login:u.login?.role===role))&&(!enrollment||(enrollment==='yes'?!!u.salesman:!u.salesman)));
  const pages=Math.max(1,Math.ceil(filtered.length/25)),current=Math.min(page,pages),visible=filtered.slice((current-1)*25,current*25);
  const counts=[['People',users.length],['With app access',users.filter(u=>u.login?.status==='active').length],['Enrolled salesmen',users.filter(u=>u.salesman).length],['No app access',users.filter(u=>!u.login).length]];
  return <div className="st-page company-users">
    <header className="company-users-header"><div><h1><Users size={24}/>Users</h1><p>Everyone connected to this company, with their app access and salesman enrollment in one place.</p></div><Button variant="secondary" onClick={refresh} disabled={loading}><RefreshCw size={15}/>Refresh</Button></header>
    {editing&&<UserAccessEditor person={editing.person} enrollOnly={editing.enrollOnly} onClose={()=>setEditing(null)} onSaved={()=>{setEditing(null);setNotice('User updated. Role changes take effect on their next sign-in.');refresh();}}/>}
    {notice&&<p role="status">{notice}</p>}
    <DirectorySync resource="team" onSynced={refresh}/>
    {error&&<div role="alert" className="proposal-error">{error} <Button variant="secondary" onClick={refresh}>Retry</Button></div>}
    <div className="company-user-counts">{counts.map(([label,count])=><div key={label}><span>{label}</span><strong>{loading&&!data?'—':count}</strong></div>)}</div>
    <section className="company-users-panel" aria-label="Company users">
      <div className="company-users-filters"><label>Search users<input placeholder="Search name or email…" value={search} onChange={e=>{setSearch(e.target.value);setPage(1);}}/></label><label>User role<select value={role} onChange={e=>{setRole(e.target.value);setPage(1);}}><option value="">All roles</option>{Object.keys(ROLE_LABEL).map(r=><option key={r} value={r}>{roleLabel(r)}</option>)}<option value="none">No app access</option></select></label><label>Salesman enrollment<select value={enrollment} onChange={e=>{setEnrollment(e.target.value);setPage(1);}}><option value="">Everyone</option><option value="yes">Enrolled</option><option value="no">Not enrolled</option></select></label></div>
      <p className="company-users-help">User roles control access to Sales Tracker. GoHighLevel roles come from your sub-account. A user can be both an administrator and a salesman.</p>
      {loading&&<p role="status">Loading company users…</p>}
      {!loading&&data&&<><div className="st-table-wrap"><table className="st-table"><thead><tr><th>User</th><th>User role</th><th>Salesman status</th><th>GoHighLevel role</th><th>Source</th><th>Actions</th></tr></thead><tbody>{visible.map(u=><tr key={u.key}>
        <td><strong>{u.name}</strong><small className="st-block">{u.email||'No email provided'}</small></td>
        <td><span className={`company-role ${u.login?'has-role':''}`}>{roleLabel(u.login?.role)}</span>{u.login&&u.login.status!=='active'&&<small className="st-block">Login {u.login.status}</small>}</td>
        <td>{u.salesman?<><span className="company-role has-role">{roleLabel(u.salesman.role)}</span><small className="st-block">{u.salesman.status==='active'?'Active enrollment':'Inactive enrollment'}</small></>:<span className="company-role">Not enrolled</span>}</td>
        <td>{u.directory?<><span>{u.directory.provider_role||'Not supplied'}</span><small className="st-block">{u.directory.active?'Active in GoHighLevel':'Inactive in GoHighLevel'}</small></>:'Not connected'}</td>
        <td>{u.directory?'GoHighLevel':u.login?'Sales Tracker login':'Manually added salesman'}{u.matchedByEmail&&<small className="st-block">Login matched by unique email</small>}</td>
        <td><div className="st-row-buttons">{(u.login||u.directory)&&<Button variant="secondary" size="sm" disabled={u.login?.id===user?.id||(u.login?.role==='owner'&&user?.role!=='owner')} onClick={()=>setEditing({person:u,enrollOnly:false})}>Change role</Button>}{!u.salesman&&(u.login||u.directory)&&<Button variant="secondary" size="sm" onClick={()=>setEditing({person:u,enrollOnly:true})}>Make salesman</Button>}</div>{u.login?.id===user?.id&&<small className="st-block">Your account</small>}{!u.login&&!u.directory&&<small>Link a GoHighLevel user from the salesman profile to enable app access.</small>}</td>
      </tr>)}</tbody></table></div>{!visible.length&&<p className="company-users-empty">{users.length?'No users match these filters.':'No users found. Sync your GoHighLevel sub-account to load its users.'}</p>}
      <footer className="company-users-footer"><span>{filtered.length} {filtered.length===1?'person':'people'} · Page {current} of {pages}</span><div><Button variant="secondary" disabled={current===1} onClick={()=>setPage(current-1)}>Previous</Button><Button variant="secondary" disabled={current===pages} onClick={()=>setPage(current+1)}>Next</Button></div></footer></>}
    </section>
    <p className="company-users-help">“No app access” means there is no linked Sales Tracker login. “Not enrolled” means the user has not been added as a salesman. To enroll someone, open <Link to="/people">Salesman → Add → Import from Users</Link>. Use Change role to manage app access. Only owners can assign Owner access. GoHighLevel roles remain unchanged.</p>
  </div>;
}
