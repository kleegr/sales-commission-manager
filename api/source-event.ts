import type {VercelRequest,VercelResponse} from '@vercel/node';
import {database,TrackerError} from './_lib/tracker-common.js';
import {captureSource} from './_lib/operations.js';
export default async function handler(req:VercelRequest,res:VercelResponse){
 res.setHeader('Cache-Control','no-store');if(req.method!=='POST')return res.status(405).json({error:'method_not_allowed'});
 try{const b=typeof req.body==='string'?JSON.parse(req.body):req.body;if(!b||JSON.stringify(b).length>16000)throw new TrackerError('invalid_payload','Provide a small event object.');const secret=String(req.headers.authorization||'').replace(/^Bearer /,'');return res.json(await database.transaction(db=>captureSource(db,String(req.query.source||''),secret,b)));}
 catch(e){return res.status(e instanceof TrackerError?e.status:400).json({error:e instanceof TrackerError?e.code:'invalid_event',message:e instanceof TrackerError?e.message:'The event could not be accepted.'});}
}
