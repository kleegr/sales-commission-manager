import type {SessionUser} from './auth.js';
import {type SQL,dateOnly,TrackerError} from './tracker-common.js';
import {report,exportResource,listResource} from './tracker-read.js';
import {displayMinor} from '../../src/lib/exact-commission.js';

export function monthRange(value:string){if(!/^\d{4}-\d{2}$/.test(value))throw new TrackerError('invalid_month','Choose a reporting month.');const from=dateOnly(`${value}-01`),d=new Date(`${from}T00:00:00Z`);d.setUTCMonth(d.getUTCMonth()+1);d.setUTCDate(0);return{from,to:d.toISOString().slice(0,10)};}
/** Small, dependency-free, paginated text PDF. Exact amounts are rendered as strings. */
export function textPDF(lines:string[]){
 const clean=(s:string)=>s.replace(/[^\x20-\x7e]/g,'?');const wrapped=lines.flatMap(s=>{const text=clean(s);return text.match(/.{1,95}(?:\s|$)|.{1,95}/g)||[''];});
 const pages:string[][]=[];for(let i=0;i<wrapped.length;i+=48)pages.push(wrapped.slice(i,i+48));if(!pages.length)pages.push(['No records.']);
 const objects:string[]=['','<< /Type /Catalog /Pages 2 0 R >>','', '<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>'];const kids:number[]=[];
 for(const page of pages){const pageId=objects.length,streamId=pageId+1;kids.push(pageId);const stream=`BT /F1 9 Tf 40 790 Td 14 TL\n${page.map((line,i)=>`${i?'T* ':''}(${line.replace(/([\\()])/g,'\\$1')}) Tj`).join('\n')}\nET`;
 objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${streamId} 0 R >>`,`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);}
 objects[2]=`<< /Type /Pages /Kids [${kids.map(n=>`${n} 0 R`).join(' ')}] /Count ${kids.length} >>`;
 let output='%PDF-1.4\n';const offsets=[0];for(let i=1;i<objects.length;i++){offsets.push(Buffer.byteLength(output));output+=`${i} 0 obj\n${objects[i]}\nendobj\n`;}
 const start=Buffer.byteLength(output);output+=`xref\n0 ${objects.length}\n0000000000 65535 f \n${offsets.slice(1).map(n=>`${String(n).padStart(10,'0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`;return Buffer.from(output);
}
export async function monthlyPackage(db:SQL,u:SessionUser,month:string){
 const range=monthRange(month),summary=await report(db,u,range),w=(await db.query('SELECT payout_terms FROM tracker_workspaces WHERE tenant_id=$1',[u.tenantId])).rows[0],digits=Number(w?.payout_terms?.minorDigits??2);
 const lines=[`SALES TRACKER - ${month}`,`Workspace: ${u.tenantName}`,`Period: ${range.from} through ${range.to}`,`Generated: ${new Date().toISOString()}`,'','RECEIPTS (recorded payment date)'];
 for(const r of summary.receipts||[])lines.push(`${r.currency}: net collected ${displayMinor(String(r.net_collected_minor||'0'),r.currency,digits)}`);
 lines.push('','EARNINGS (event cohort; paid means settled from this cohort)');
 for(const r of summary.earnings||[])lines.push(`${r.currency}: earned ${displayMinor(String(r.earned_minor||'0'),r.currency,digits)}; paid ${displayMinor(String(r.paid_minor||'0'),r.currency,digits)}`);
 const settlements=await listResource(db,u,'settlements',{...range,limit:'100'});lines.push('',`SETTLEMENTS: ${settlements.total} records in this cash-date period`,'See settlements.csv for complete details.');
 lines.push('','DEFINITIONS','Forecasts are excluded. Currencies are separate. Legacy non-exact history is excluded.','Earning dates and bank settlement dates describe different periods.','The app records payout evidence; this report is not proof of a bank transfer.');
 const files=[{name:`summary-${month}.pdf`,data:textPDF(lines)},{name:`receipts-${month}.csv`,data:Buffer.from(await exportResource(db,u,'payments',range))},{name:`earnings-${month}.csv`,data:Buffer.from(await exportResource(db,u,'ledger',range))},{name:`settlements-${month}.csv`,data:Buffer.from(await exportResource(db,u,'settlements',range))},{name:'definitions.txt',data:Buffer.from(lines.join('\n'))}];
 return zipStore(files);
}
function crc32(bytes:Buffer){let c=0xffffffff;for(const b of bytes){c^=b;for(let k=0;k<8;k++)c=(c>>>1)^((c&1)?0xedb88320:0);}return(c^0xffffffff)>>>0;}
export function zipStore(files:{name:string;data:Buffer}[]){const chunks:Buffer[]=[],central:Buffer[]=[];let offset=0;for(const f of files){const name=Buffer.from(f.name),crc=crc32(f.data),h=Buffer.alloc(30);h.writeUInt32LE(0x04034b50);h.writeUInt16LE(20,4);h.writeUInt32LE(crc,14);h.writeUInt32LE(f.data.length,18);h.writeUInt32LE(f.data.length,22);h.writeUInt16LE(name.length,26);const c=Buffer.alloc(46);c.writeUInt32LE(0x02014b50);c.writeUInt16LE(20,4);c.writeUInt16LE(20,6);c.writeUInt32LE(crc,16);c.writeUInt32LE(f.data.length,20);c.writeUInt32LE(f.data.length,24);c.writeUInt16LE(name.length,28);c.writeUInt32LE(offset,42);central.push(c,name);chunks.push(h,name,f.data);offset+=h.length+name.length+f.data.length;}const cd=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(files.length,8);end.writeUInt16LE(files.length,10);end.writeUInt32LE(cd.length,12);end.writeUInt32LE(offset,16);return Buffer.concat([...chunks,cd,end]);}
