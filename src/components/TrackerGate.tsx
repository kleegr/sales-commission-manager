import {createContext,useContext,useEffect,useState,type ReactNode} from 'react';
import {trackerGet} from '../lib/tracker-client';
import TrackerPage from '../pages/TrackerPage';
import TrackerAgency from '../pages/TrackerAgency';
const Context=createContext<{installed:boolean;workspace:any;loading:boolean;error:string;refresh:()=>void}>({installed:false,workspace:null,loading:true,error:'',refresh:()=>{}});
export function TrackerProvider({children}:{children:ReactNode}){const [status,setStatus]=useState({installed:false,workspace:null,loading:true,error:''});const [revision,setRevision]=useState(0);useEffect(()=>{const c=new AbortController();trackerGet('status',{},c.signal).then(b=>setStatus({...b,loading:false,error:''})).catch(e=>{if(!c.signal.aborted)setStatus(s=>({...s,loading:false,error:e.message}));});return()=>c.abort();},[revision]);return <Context.Provider value={{...status,refresh:()=>setRevision(n=>n+1)}}>{children}</Context.Provider>;}
export const useTracker=()=>useContext(Context);
export function TrackerGate({resource,children}:{resource:string;children?:ReactNode}){const s=useTracker();if(s.loading)return <p role="status">Loading workspace…</p>;if(s.error)return <div role="alert"><p>{s.error}</p><button onClick={s.refresh}>Retry</button></div>;if(!s.installed)return children?<>{children}</>:<p>The reviewed Sales Tracker database update is required to activate this area.</p>;if(resource==='agency')return <TrackerAgency/>;return <TrackerPage key={resource} resource={resource}/>;}
