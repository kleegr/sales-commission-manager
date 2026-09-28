import {useState} from 'react';
import {affiliateURL} from '../../lib/affiliate-link';
import {Action,Message} from './Experience';

export default function SubmissionCampaign({campaign,links}:{campaign:any;links:any[]}){
 const [error,setError]=useState(''),[notice,setNotice]=useState('');
 return <section aria-label="Submission tracking"><h3>Salesman referral links</h3><p className="st-help">Share a personal link to this {campaign.tracking_policy.source.selection.kind}. A submission is a lead, not a paid order.</p>
 {links.map(r=><div className="st-disclosure" key={r.link_id}><strong>{r.salesperson_name}</strong><label className="st-field"><span>Personal affiliate link</span><input readOnly value={affiliateURL(r.link_id,campaign.destination_url,'off')} onFocus={e=>e.target.select()}/></label><Action disabled={!r.active} onClick={async()=>{try{await navigator.clipboard.writeText(affiliateURL(r.link_id,campaign.destination_url,'off'));setNotice(`Link copied for ${r.salesperson_name}.`);}catch{setError('Select the link above and copy it.');}}}>Copy link</Action></div>)}
 <Message error={error} notice={notice}/>
 </section>;
}
