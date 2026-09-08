import { randomUUID } from 'node:crypto';
import { query, withTransaction } from './db.js';
import type { SessionUser } from './auth.js';

export interface SQL { query<T = any>(sql: string, params?: any[]): Promise<{rows:T[];rowCount?:number}> }
export interface Database extends SQL { transaction<T>(fn:(sql:SQL)=>Promise<T>):Promise<T> }
export const database: Database = { query, transaction: fn => withTransaction(c => fn(c)) };
export class TrackerError extends Error { constructor(public code:string, message:string,public status=400){super(message);} }
export const id = (prefix:string) => `${prefix}_${randomUUID().replaceAll('-','')}`;
export const isAdmin = (u:SessionUser) => u.role==='owner'||u.role==='admin';
export function admin(u:SessionUser) { if(!isAdmin(u))throw new TrackerError('forbidden','An administrator must perform this action.',403); }
export function required(v:unknown,name:string,max=500):string {if(typeof v!=='string'||!v.trim()||v.length>max)throw new TrackerError('invalid_input',`${name} is required (maximum ${max} characters).`);return v.trim();}
export function dateOnly(v:unknown,name='Date'):string {const s=required(v,name,10);if(!/^\d{4}-\d{2}-\d{2}$/.test(s)||!Number.isFinite(Date.parse(s))||new Date(s).toISOString().slice(0,10)!==s)throw new TrackerError('invalid_date',`${name} must be a valid calendar date.`);return s;}
export async function trackerInstalled(db:SQL=database):Promise<boolean>{const r=await db.query("SELECT 1 FROM schema_migrations WHERE id='0012_sales_tracker'");return r.rows.length>0;}
export async function lock(db:SQL,tenantId:string){await db.query('SELECT pg_advisory_xact_lock(hashtext($1))',[tenantId]);}
export async function audit(db:SQL,u:SessionUser,entity:string,entityId:string,action:string,details:unknown){await db.query(`INSERT INTO audit_logs(id,tenant_id,entity_type,entity_id,action,after,created_at) VALUES($1,$2,$3,$4,$5,$6::jsonb,now())`,[id('audit'),u.tenantId,entity,entityId,action,JSON.stringify({actorId:u.id,...(details as object)})]);await db.query('UPDATE tenants SET data_revision=data_revision+1 WHERE id=$1',[u.tenantId]);}
export async function visibleIds(db:SQL,u:SessionUser):Promise<string[]|null>{if(isAdmin(u))return null;if(u.role==='sales_manager')return(await db.query('SELECT id FROM salespeople WHERE tenant_id=$1 AND manager_user_id=$2',[u.tenantId,u.id])).rows.map(r=>r.id);return u.salespersonId?[u.salespersonId]:[];}
export async function participant(db:SQL,u:SessionUser,spId:string){const r=await db.query('SELECT * FROM salespeople WHERE tenant_id=$1 AND id=$2',[u.tenantId,spId]);const ids=await visibleIds(db,u);if(!r.rows[0]||(ids&&!ids.includes(spId)))throw new TrackerError('not_found','Participant not found in your permitted workspace.',404);return r.rows[0];}
export async function client(db:SQL,u:SessionUser,clientId:string){const r=await db.query('SELECT * FROM clients WHERE tenant_id=$1 AND id=$2',[u.tenantId,clientId]);const ids=await visibleIds(db,u);const row=r.rows[0];if(!row||(ids&&!ids.some(i=>[row.salesperson_id,row.referrer_id,row.closer_id].includes(i))))throw new TrackerError('not_found','Lead not found in your permitted workspace.',404);return row;}
export async function workspace(db:SQL,u:SessionUser){const r=await db.query('SELECT * FROM tracker_workspaces WHERE tenant_id=$1',[u.tenantId]);if(!r.rows[0])throw new TrackerError('workspace_setup_required','Confirm workspace currency and timezone in Sales Tracker setup before recording financial events.',409);return r.rows[0];}
