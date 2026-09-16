// ============================================================================
// PUBLIC PRODUCT TRACKING LINK REDIRECT  —  GET /api/pl?l=<link_id>
// (also reached as /pl/<link_id> via the vercel.json rewrite)
//
// Unauthenticated. Looks up the per-product tracking link; if it is active and
// its product has a buy/checkout destination, it records the click (best-effort,
// guarded, captures IP) and 302-redirects the buyer to that destination with an
// appended ?ref=<link_id> (existing query preserved). The ?ref value is the SEAM
// a later commission-on-purchase wave uses to credit the rep from a paid GHL
// order. Missing/inactive/no-destination links get a neutral 404. No-store.
// ============================================================================
import type {VercelRequest,VercelResponse} from '@vercel/node';
import {database} from './_lib/tracker-common.js';
import {hasDb} from './_lib/db.js';
import {clientIp} from './_lib/http.js';
import {resolveProductLink,recordProductLinkClick,LINK_ID_RE} from './_lib/product-links.js';

export const config={maxDuration:30};
const notFound=(res:VercelResponse)=>{res.setHeader('Content-Type','text/html; charset=utf-8');return res.status(404).send('<!doctype html><meta charset="utf-8"><title>Link unavailable</title><body style="font-family:system-ui;margin:4rem auto;max-width:32rem;text-align:center"><h1>This link is not available</h1><p>The tracking link is inactive or does not exist.</p></body>');};

export default async function handler(req:VercelRequest,res:VercelResponse){
  res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','no-referrer');
  if(req.method!=='GET')return res.status(405).json({error:'method_not_allowed'});
  const linkId=String((Array.isArray(req.query.l)?req.query.l[0]:req.query.l)||'').trim();
  if(!LINK_ID_RE.test(linkId)||!hasDb())return notFound(res);
  try{
    const link=await resolveProductLink(database,linkId);
    if(!link||!link.active||!link.destination_url)return notFound(res);
    const contactId=String((Array.isArray(req.query.contact_id)?req.query.contact_id[0]:(req.query.contact_id||req.query.contactId))||'').trim();
    // Best-effort click capture; never blocks or fails the redirect.
    try{await recordProductLinkClick(database,linkId,{ip:clientIp(req),ref:String(req.headers.referer||''),contactId});}catch{/* best-effort */}
    const dest=new URL(link.destination_url);dest.searchParams.set('ref',linkId);
    res.setHeader('Location',dest.toString());return res.status(302).end();
  }catch{return notFound(res);}
}
