import type {VercelRequest,VercelResponse} from '@vercel/node';
import {database,TrackerError} from './_lib/tracker-common.js';
import {captureStripe,verifyStripeSignature} from './_lib/operations-providers.js';
export const config={api:{bodyParser:false}};
export default async function handler(req:VercelRequest,res:VercelResponse){
 res.setHeader('Cache-Control','no-store');if(req.method!=='POST')return res.status(405).json({error:'method_not_allowed'});
 try{const chunks:Buffer[]=[];let size=0;for await(const chunk of req){const b=Buffer.from(chunk);size+=b.length;if(size>1000000)throw new TrackerError('too_large','Event exceeds size limit.',413);chunks.push(b);}const raw=Buffer.concat(chunks).toString('utf8');verifyStripeSignature(raw,String(req.headers['stripe-signature']||''),process.env.STRIPE_WEBHOOK_SECRET||'');return res.json(await database.transaction(db=>captureStripe(db,JSON.parse(raw))));}
 catch(e){return res.status(e instanceof TrackerError?e.status:500).json({error:e instanceof TrackerError?e.code:'event_not_persisted'});}
}
