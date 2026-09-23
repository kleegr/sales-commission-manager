import {type ReactNode} from 'react';
import {Link,useLocation} from 'react-router-dom';
import {ChevronDown} from 'lucide-react';
import {useAuth} from '../../store/AuthContext';
import {useFeatures} from '../../store/FeaturesContext';
import {canAccess,type Role} from '../../lib/roles';
import {featureAllowsPath} from '../../lib/features';
import {usePreferences} from '../tracker/Experience';
export function Layout({children}:{children:ReactNode}){
 const {user}=useAuth(),{features}=useFeatures(),{pathname}=useLocation(),p=usePreferences().values;
 const role=(user?.role||'salesperson') as Role;
 const allowed=(path:string)=>canAccess(role,path)&&featureAllowsPath(path,role,features);
 // Simplified navigation: only the core sell → commission → pay flow is shown.
 // Secondary/analytics screens (operations, reports, goals, recruiting, sync,
 // media, permissions) still exist and stay reachable by URL — they are just
 // kept out of the menu so the app reads as the flow the business actually runs.
 const primary=[{to:role==='owner'?'/workspace-overview':'/',label:'Dashboard'},{to:'/products',label:'Products'},{to:'/plans',label:p.structureLabel},{to:'/people',label:p.salesmanLabel},{to:'/users',label:'Users'},{to:'/documents',label:'Proposals'},{to:'/payouts',label:p.payoutLabel},{to:'/tracker-settings',label:'Settings'}].filter(i=>allowed(i.to));
 const more=[['/clients','Clients'],['/opportunities','Opportunities'],['/payments','Payments'],['/ledger','Commission ledger'],['/campaigns','Campaigns & links'],['/portal','My portal'],['/settings/integrations/kleegr','CRM connection']].filter(([path])=>allowed(path));
 return <div className="app-shell st-shell"><a className="skip-link" href="#main-content">Skip to content</a><header className="st-topbar"><nav aria-label="Primary navigation" className="st-nav">{primary.map(i=><Link key={i.to} to={i.to} aria-current={pathname===i.to||(i.to!=='/'&&pathname.startsWith(i.to+'/'))?'page':undefined}>{i.label}</Link>)}{more.length>0&&<details className="st-menu st-more"><summary>More <ChevronDown size={14}/></summary><div className="st-menu-list">{more.map(([path,label])=><Link key={path} to={path} onClick={e=>{e.currentTarget.closest('details')!.open=false;}} aria-current={pathname===path?'page':undefined}>{label}</Link>)}</div></details>}</nav></header><main id="main-content" key={pathname} tabIndex={-1} className="st-main">{children}</main></div>;
}
