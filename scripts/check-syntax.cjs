"use strict";
const fs=require("node:fs"),path=require("node:path"),{execFileSync}=require("node:child_process");
const root=path.join(__dirname,"..");
function gather(directory){
 return fs.readdirSync(directory,{withFileTypes:true}).flatMap(entry=>{
  if(entry.isDirectory()) return gather(path.join(directory,entry.name));
  return entry.isFile() && /\.(?:js|cjs)$/.test(entry.name)
    ? [path.join(directory,entry.name)] : [];
 });
}
const files=[path.join(root,"index.js"),...gather(path.join(root,"ai-trading"))];
for(const file of files)execFileSync(process.execPath,["--check",file],{stdio:"inherit"});
console.log("Syntax checked "+files.length+" files");
