export interface CompanyIdentity {
  id: string; name: string; email: string; role?: string; status?: string;
  external_id?: string; provider?: string; provider_role?: string; active?: boolean;
  participant_id?: string; salesperson_id?: string; kleegr_user_id?: string; ghl_user_id?: string;
}
export interface CompanyUser {
  key: string; name: string; email: string;
  directory?: CompanyIdentity; login?: CompanyIdentity; salesman?: CompanyIdentity;
  matchedByEmail?: boolean;
}
/** Join identities only within the already tenant-scoped API results. Never join by name. */
export function companyUsers(directory: CompanyIdentity[], logins: CompanyIdentity[], salesmen: CompanyIdentity[]): CompanyUser[] {
  const usedLogins=new Set<string>(), usedSalesmen=new Set<string>();
  const email=(value:string)=>value.trim().toLowerCase();
  const attach=(d?:CompanyIdentity,l?:CompanyIdentity):CompanyIdentity|undefined=>{
    const person=salesmen.find(s=>s.id===d?.participant_id||s.id===l?.salesperson_id||!!l?.kleegr_user_id&&s.ghl_user_id===l.kleegr_user_id);
    if(person)usedSalesmen.add(person.id);
    return person;
  };
  const rows:CompanyUser[]=directory.map(d=>{
    const exact=logins.filter(l=>!usedLogins.has(l.id)&&d.provider==='ghl'&&l.kleegr_user_id===d.external_id);
    const candidates=logins.filter(l=>!usedLogins.has(l.id)&&!l.kleegr_user_id&&!!d.email&&email(l.email)===email(d.email));
    const uniqueEmail=directory.filter(other=>!!d.email&&email(other.email)===email(d.email)).length===1;
    const login=exact.length===1?exact[0]:!exact.length&&uniqueEmail&&candidates.length===1?candidates[0]:undefined;
    if(login)usedLogins.add(login.id);
    return {key:`directory:${d.provider}:${d.external_id}`,name:d.name||login?.name||'Unnamed user',email:d.email||login?.email||'',directory:d,login,salesman:attach(d,login),matchedByEmail:!!login&&!exact.length};
  });
  for(const login of logins)if(!usedLogins.has(login.id))rows.push({key:`login:${login.id}`,name:login.name||'Unnamed user',email:login.email,login,salesman:attach(undefined,login)});
  for(const salesman of salesmen)if(!usedSalesmen.has(salesman.id))rows.push({key:`salesman:${salesman.id}`,name:salesman.name||'Unnamed salesman',email:salesman.email,salesman});
  return rows.sort((a,b)=>a.name.localeCompare(b.name)||a.key.localeCompare(b.key));
}
