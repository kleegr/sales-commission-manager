import type {VercelRequest,VercelResponse} from '@vercel/node';
import {database,trackerInstalled,TrackerError} from './_lib/tracker-common.js';
import {referralClick,convertReferral} from './_lib/tracker-attribution.js';
import {csrfOk} from './_lib/http.js';

export default async function handler(req:VercelRequest,res:VercelResponse){
  res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','no-referrer');
  try{
    if(!await trackerInstalled())return res.status(503).json({error:'unavailable'});
    if(req.method==='GET'){const result=await database.transaction(db=>referralClick(db,String(req.query.code||'')));return res.json(result);}
    if(req.method!=='POST')return res.status(405).json({error:'method_not_allowed'});
    if(!csrfOk(req))return res.status(403).json({error:'csrf_check_failed'});
    const b=typeof req.body==='string'?JSON.parse(req.body):req.body;if(JSON.stringify(b).length>4000)return res.status(413).json({error:'too_large'});
    return res.json(await database.transaction(db=>convertReferral(db,b)));
  }catch(e){return res.status(e instanceof TrackerError?e.status:400).json({error:'referral_failed',message:e instanceof TrackerError?e.message:'This referral could not be processed.'});}
}
