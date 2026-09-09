/** RFC 4180 fields, including quoted commas, CRLF and embedded newlines. */
export function parseSalesmanCSV(input:string):string[][]{
 const text=input.replace(/^\uFEFF/,''),rows:string[][]=[];let row:string[]=[],field='',quoted=false,closed=false;
 const push=()=>{row.push(field);field='';closed=false;};
 for(let i=0;i<text.length;i++){const c=text[i];if(quoted){if(c==='"'){if(text[i+1]==='"'){field+='"';i++;}else{quoted=false;closed=true;}}else field+=c;continue;}
  if(c==='"'){if(field||closed)throw new Error('Unexpected quote in CSV.');quoted=true;}
  else if(c===','){push();}
  else if(c==='\n'||c==='\r'){if(c==='\r'&&text[i+1]==='\n')i++;push();if(row.some(v=>v.trim()))rows.push(row);row=[];}
  else{if(closed&&c.trim())throw new Error('Unexpected text after a quoted field.');if(!closed)field+=c;}
 }
 if(quoted)throw new Error('A quoted CSV field was not closed.');push();if(row.some(v=>v.trim()))rows.push(row);
 if(rows.length<2)throw new Error('Add a header row and at least one salesman.');if(rows.length>501)throw new Error('Upload up to 500 salesmen at a time.');if(rows[0].length>50)throw new Error('Upload a CSV with 50 columns or fewer.');if(rows.some(r=>r.length!==rows[0].length))throw new Error('Each CSV row must have the same number of columns.');return rows;
}
