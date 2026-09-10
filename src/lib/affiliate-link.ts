export function affiliateURL(linkId:string,destination:string|undefined,mode:string|undefined){
 if(destination&&['test','live','auto'].includes(mode||'')){const url=new URL(destination);url.searchParams.set('st_ref',linkId);return url.toString();}
 return `${window.location.origin}/join?code=${encodeURIComponent(linkId)}`;
}
