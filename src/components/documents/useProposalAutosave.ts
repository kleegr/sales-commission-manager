import {useEffect,useRef,useState} from 'react';
import {proposalRequest} from '../../lib/proposal-workspace-client';

export function useProposalAutosave(key:string,payload:Record<string,unknown>,restore:(payload:any)=>void){
  const [ready,setReady]=useState(false),[status,setStatus]=useState('Loading saved draft…'),[error,setError]=useState('');
  const current=useRef(payload),restoreRef=useRef(restore),version=useRef(0),saved=useRef(''),pending=useRef<Promise<void>|null>(null),stopped=useRef(false);
  current.current=payload;restoreRef.current=restore;
  useEffect(()=>{let active=true;proposalRequest({op:'autosave',key},true).then(r=>{if(!active)return;version.current=r.version;saved.current=JSON.stringify(r.payload||current.current);if(r.payload)restoreRef.current(r.payload);setStatus(r.payload?'Saved draft restored':'Changes save automatically');setReady(true);}).catch(e=>{if(active){setError(e.message);setStatus('Autosave unavailable');setReady(true);}});return()=>{active=false;};},[key]);
  async function flush(){
    if(pending.current)await pending.current;
    if(stopped.current||!ready)return;
    const snapshot=JSON.stringify(current.current);if(snapshot===saved.current)return;
    setStatus('Saving draft…');
    pending.current=proposalRequest({op:'autosave',key,version:version.current,payload:current.current}).then(r=>{version.current=r.version;saved.current=snapshot;setStatus('Draft saved');setError('');}).catch(e=>{setStatus('Draft not saved');setError(e.message);throw e;}).finally(()=>{pending.current=null;});
    await pending.current;
  }
  const serialized=JSON.stringify(payload);
  useEffect(()=>{if(!ready)return;const timer=setTimeout(()=>{void flush().catch(()=>{});},900);return()=>clearTimeout(timer);},[serialized,ready]);
  useEffect(()=>{const warn=(e:BeforeUnloadEvent)=>{if(ready&&!stopped.current&&JSON.stringify(current.current)!==saved.current){e.preventDefault();e.returnValue='';}};window.addEventListener('beforeunload',warn);return()=>window.removeEventListener('beforeunload',warn);},[ready]);
  async function clear(){await flush();stopped.current=true;await proposalRequest({op:'autosave',key,version:version.current,clear:true});}
  return {ready,status,error,flush,clear};
}
