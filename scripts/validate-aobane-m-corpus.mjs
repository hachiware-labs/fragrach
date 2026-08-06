import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { corpusRoot } from "./generate-aobane-m-corpus.mjs";

const list=(root)=>{const out=[];const walk=d=>fs.readdirSync(d,{withFileTypes:true}).forEach(e=>e.isDirectory()?walk(path.join(d,e.name)):out.push(path.join(d,e.name)));walk(root);return out.sort();};
const jsonl=(file)=>fs.readFileSync(file,"utf8").split(/\r?\n/).filter(Boolean).map((line,i)=>{try{return JSON.parse(line);}catch(e){throw new Error(`${file}:${i+1}: ${e.message}`);}});
const section=(text,name)=>{const lines=text.split(/\r?\n/),escaped=name.replace(/[.*+?^${}()|[\]\\]/g,"\\$&"),heading=new RegExp(`^(#{1,6})\\s+${escaped}\\s*$`);let start=-1,level=null;for(let i=0;i<lines.length;i++){const match=lines[i].match(heading);if(match){start=i;level=match[1].length;break;}if(lines[i].trim()===name){start=i;break;}}if(start<0)return null;let end=lines.length;for(let i=start+1;i<lines.length;i++){const match=lines[i].match(/^(#{1,6})\s+/);if(level!==null&&match&&match[1].length<=level){end=i;break;}}return lines.slice(start,end).join("\n");};
const units=(text)=>{let count=0,block=false;for(const line of text.split(/\r?\n/)){if(/^#{1,6} /.test(line)){count++;block=false;}else if(!line.trim())block=false;else if(!block){count++;block=true;}}return count;};

export function validateCorpus(root=corpusRoot){
  const errors=[],warnings=[],sourceRoot=path.join(root,"sources"),files=list(sourceRoot);
  const relative=new Set(files.map(f=>`sources/${path.relative(sourceRoot,f).replaceAll("\\","/")}`));
  if(files.length!==500)errors.push(`source document count must be 500, got ${files.length}`);
  const formats={},hashes=new Map();let characters=0,evidence=0;
  for(const file of files){
    const ext=path.extname(file).toLowerCase();formats[ext]=(formats[ext]??0)+1;
    if(![".md",".markdown",".txt"].includes(ext))errors.push(`unsupported source format: ${file}`);
    const text=fs.readFileSync(file,"utf8");characters+=text.length;evidence+=units(text);
    if(!text.trim())errors.push(`empty source: ${file}`);
    const hash=crypto.createHash("sha256").update(text).digest("hex"),members=hashes.get(hash)??[];members.push(file);hashes.set(hash,members);
  }
  const groups=[...hashes.values()].filter(x=>x.length>1),duplicates=groups.reduce((n,x)=>n+x.length-1,0),ratio=duplicates/files.length;
  if(ratio<.05||ratio>.10)errors.push(`exact duplicate ratio must be 5-10%, got ${(ratio*100).toFixed(1)}%`);
  if(evidence<4000||evidence>8000)warnings.push(`evidence estimate is outside 4,000-8,000: ${evidence}`);
  const questions=jsonl(path.join(root,"evaluation/questions.jsonl")),ids=new Set(),tags={};
  if(questions.length!==100)errors.push(`question count must be 100, got ${questions.length}`);
  for(const q of questions){
    if(ids.has(q.id))errors.push(`duplicate question id: ${q.id}`);ids.add(q.id);
    for(const key of ["intent_id","question","as_of","expected_behavior","expected_answer_elements","required_evidence","forbidden_answer_elements","tags"])if(q[key]===undefined)errors.push(`${q.id}: missing ${key}`);
    for(const tag of q.tags??[])tags[tag]=(tags[tag]??0)+1;
    for(const ev of q.required_evidence??[]){
      if(!relative.has(ev.source)){errors.push(`${q.id}: missing source ${ev.source}`);continue;}
      const text=fs.readFileSync(path.join(root,...ev.source.split("/")),"utf8"),scope=ev.section?section(text,ev.section):text;
      if(scope===null){errors.push(`${q.id}: missing section ${ev.source}#${ev.section}`);continue;}
      const termScope=ev.source.includes("/60-generated/")?scope:text;
      for(const term of ev.content_terms??[])if(!termScope.includes(term))errors.push(`${q.id}: missing term "${term}" in ${ev.source}#${ev.section}`);
    }
  }
  for(const [tag,min] of Object.entries({"multi-document":20,temporal:15,conflict:15,"information-absence":15,table:10}))if((tags[tag]??0)<min)errors.push(`tag ${tag} requires ${min}, got ${tags[tag]??0}`);
  const intents=new Set(list(path.join(root,"intents")).map(f=>fs.readFileSync(f,"utf8").match(/^id:\s*(.+)$/m)?.[1]?.trim()).filter(Boolean));
  for(const id of ["design-review","incident-response","onboarding","project-history","compliance-audit"])if(!intents.has(id))errors.push(`missing intent: ${id}`);
  for(const file of ["evidence.jsonl","aliases.jsonl","versions.jsonl","conflicts.jsonl","duplicates.jsonl","answers.jsonl"])if(!fs.existsSync(path.join(root,"gold",file)))errors.push(`missing gold/${file}`);
  return {ok:errors.length===0,errors,warnings,inventory:{source_documents:files.length,formats,total_characters:characters,evidence_units_estimate:evidence,exact_duplicate_groups:groups.length,exact_duplicate_documents:duplicates,exact_duplicate_ratio:Number(ratio.toFixed(4)),questions:questions.length,tags,intents:[...intents].sort()}};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){const result=validateCorpus();console.log(JSON.stringify(result,null,2));if(!result.ok)process.exitCode=1;}
