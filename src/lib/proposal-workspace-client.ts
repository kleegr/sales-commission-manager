export async function proposalRequest(body:Record<string,unknown>,read=false):Promise<any>{
  const response=await fetch(read?`/api/proposal-workspace?${new URLSearchParams(Object.entries(body).map(([k,v])=>[k,String(v)]))}`:'/api/proposal-workspace',read?{cache:'no-store'}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  const result=await response.json();if(!response.ok)throw new Error(result.message||result.error||'The proposal action failed.');return result;
}
