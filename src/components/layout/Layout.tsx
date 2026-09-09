import {type ReactNode} from 'react';
import {Link,useLocation} from 'react-router-dom';
import {ChevronDown,BarChart3} from 'lucide-react';
import {useAuth} from '../../store/AuthContext';
import {useFeatures} from '../../store/FeaturesContext';
import {canAccess,type Role} from '../../lib/roles';
import {featureAllowsPath} from '../../lib/features';
import {usePreferences} from '../tracker/Experience';
export function Layout({children}:{children:ReactNode}){
 const {user}=useAuth(),{features}=useFeatures(),{pathname}=useLocation(),p=usePreferences().values;
 const role=(user?.role||'salesperson') as Role;
 const allowed=(path:string)=>canAccess(role,path)&&featureAllowsPath(path,role,features);
 const primary=[{to:role==='owner'?'/workspace-overview':'/',label:'Dashboard'},{to:'/plans',label:p.structureLabel},{to:'/people',label:p.salesmanLabel},{to:'/payouts',label:p.payoutLabel},{to:'/media',label:p.mediaLabel},{to:'/tracker-settings',label:'Settings'}].filter(i=>allowed(i.to));
 const more=[['/clients','Clients & leads'],['/opportunities','Opportunities'],['/payments','Payments & refunds'],['/ledger','Commission ledger'],['/reports','Reports'],['/goals','Goals & milestones'],['/documents','Proposals & contracts'],['/campaigns','Campaigns & referral links'],['/portal','My portal'],['/present','Recruiting & projections'],['/sync-review','Sync & review'],['/settings','Permissions & app settings'],['/settings/integrations/kleegr','CRM connection']].filter(([path])=>allowed(path));
 return <div className="app-shell st-shell"><a className="skip-link" href="#main-content">Skip to content</a><header className="st-topbar"><div className="st-brand"><BarChart3 size={23}/><strong>{p.title}</strong><span>{user?.tenantName}</span></div><nav aria-label="Primary navigation" className="st-nav">{primary.map(i=><Link key={i.to} to={i.to} aria-current={pathname===i.to||(i.to!=='/'&&pathname.startsWith(i.to+'/'))?'page':undefined}>{i.label}</Link>)}{more.length>0&&<details className="st-menu st-more"><summary>More <ChevronDown size={14}/></summary><div className="st-menu-list">{more.map(([path,label])=><Link key={path} to={path} onClick={e=>{e.currentTarget.closest('details')!.open=false;}} aria-current={pathname===path?'page':undefined}>{label}</Link>)}</div></details>}</nav></header><main id="main-content" key={pathname} tabIndex={-1} className="st-main">{children}</main></div>;
}
