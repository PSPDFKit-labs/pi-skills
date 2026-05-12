#!/usr/bin/env python3
"""Read-only GitHub org supply-chain IOC scanner. Starter tool; adapt per incident."""
import argparse, base64, csv, json, os, re, time, urllib.parse, urllib.request
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed
NPM_FILES={'package.json','package-lock.json','npm-shrinkwrap.json','pnpm-lock.yaml','yarn.lock','bun.lock','bun.lockb'}; PY_FILES={'pyproject.toml','poetry.lock','uv.lock','Pipfile','Pipfile.lock','setup.py','setup.cfg'}
PREFIXES=('.github/workflows/','.buildkite/','ci/','scripts/')

def load_token(args):
    if args.token: return args.token
    if args.token_env and os.getenv(args.token_env): return os.getenv(args.token_env)
    if args.env_file:
        for line in Path(args.env_file).read_text().splitlines():
            if '=' in line:
                k,v=line.split('=',1)
                if k.strip() in ('GITHUB_TOKEN','GH_TOKEN','GITHUB_API_TOKEN'): return v.strip().strip('"\'')
    raise SystemExit('GitHub token missing; provide --token, --token-env, or --env-file')

def load_iocs(path): return json.loads(Path(path).read_text()) if path else {}
def load_affected(path):
    out={}
    if not path: return out
    with open(path,newline='',encoding='utf-8',errors='ignore') as f:
        for r in csv.DictReader(f):
            eco=(r.get('Ecosystem') or r.get('ecosystem') or '').strip().lower(); ns=(r.get('Namespace') or '').strip(); name=(r.get('Name') or r.get('Package') or '').strip(); ver=(r.get('Version') or '').strip()
            if not eco or not name or not ver: continue
            full=f'{ns}/{name}' if eco=='npm' and ns else name
            if eco=='pypi': full=full.lower().replace('_','-')
            out.setdefault(eco,{}).setdefault(full,set()).add(ver)
    return out

def exact_npm(text,f,aff):
    hits=[]; npm=aff.get('npm',{})
    if f in ('package-lock.json','npm-shrinkwrap.json'):
        try:
            for path,meta in (json.loads(text).get('packages') or {}).items():
                if path.startswith('node_modules/'):
                    name=path[13:]; ver=str(meta.get('version',''))
                    if name in npm and ver in npm[name]: hits.append({'ecosystem':'npm','package':name,'version':ver,'evidence':'package-lock packages entry'})
        except Exception: pass
    elif f=='pnpm-lock.yaml':
        for name,vers in npm.items():
            esc=re.escape(name)
            for ver in vers:
                if re.search(rf'(^|\n)\s{{2,}}/?{esc}@{re.escape(ver)}(?=\(|:|\n)', text): hits.append({'ecosystem':'npm','package':name,'version':ver,'evidence':'pnpm lock package key'})
    elif f=='package.json':
        try:
            d=json.loads(text)
            for sec in ['dependencies','devDependencies','optionalDependencies','peerDependencies']:
                for name,spec in (d.get(sec) or {}).items():
                    if name in npm:
                        for ver in npm[name]:
                            if ver in str(spec) or str(spec).strip()=='*': hits.append({'ecosystem':'npm','package':name,'version':ver,'specifier':spec,'evidence':f'package.json {sec}'})
        except Exception: pass
    return hits

def exact_py(text,f,aff):
    hits=[]
    for name,vers in aff.get('pypi',{}).items():
        esc=re.escape(name).replace('\\-','[-_]')
        for ver in vers:
            if re.search(rf'(?im)^\s*{esc}\s*(==|=)\s*["\']?{re.escape(ver)}\b', text) or (f=='poetry.lock' and re.search(rf'(?is)name\s*=\s*["\']{esc}["\'].*?version\s*=\s*["\']{re.escape(ver)}["\']', text)):
                hits.append({'ecosystem':'pypi','package':name,'version':ver,'evidence':f})
    return hits

def text_hits(text,terms):
    out=[]
    for i,l in enumerate(text.splitlines(),1):
        for t in terms:
            if t and t.lower() in l.lower(): out.append({'line':i,'term':t,'text':l[:500]})
    return out

class GH:
    def __init__(self, token): self.headers={'Authorization':f'Bearer {token}','Accept':'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','User-Agent':'supply-chain-investigation-scan'}
    def get(self,url):
        req=urllib.request.Request(url,headers=self.headers)
        with urllib.request.urlopen(req,timeout=60) as r: return json.load(r)

def interesting(path,iocs):
    n=path.split('/')[-1]
    if n in NPM_FILES or n in PY_FILES or n.startswith('requirements') or n.startswith('Dockerfile'): return True
    if path.startswith(PREFIXES): return n.endswith(('.yml','.yaml','.json','.toml','.lock','.txt','.in','.sh','.js','.mjs','.cjs')) or n.startswith('Dockerfile')
    return any((p.strip('/').lower() in path.lower()) for p in (iocs.get('persistence_paths',[]) or []))

def scan_repo(gh, org, meta, aff, iocs, terms, workflow_terms):
    name=meta['name']; branch=meta.get('default_branch') or 'main'; rr={'repo':f'{org}/{name}','default_branch':branch,'tree_truncated':False,'candidate_files':0,'exact_affected_hits':[],'malware_ioc_hits':[],'workflow_risk_hits':[],'errors':[]}
    try:
        tree=gh.get(f'https://api.github.com/repos/{org}/{name}/git/trees/{urllib.parse.quote(branch,safe="")}?recursive=1'); rr['tree_truncated']=bool(tree.get('truncated'))
        cands=[x for x in tree.get('tree',[]) if x.get('type')=='blob' and interesting(x.get('path',''),iocs)]; rr['candidate_files']=len(cands)
        for it in cands:
            path=it['path']; f=path.split('/')[-1]
            try:
                b=gh.get(f'https://api.github.com/repos/{org}/{name}/git/blobs/{it["sha"]}'); c=b.get('content',''); text=base64.b64decode(c).decode('utf-8','ignore') if b.get('encoding')=='base64' else c
            except Exception as e: rr['errors'].append({'path':path,'error':str(e)}); continue
            hits=[]
            if f in NPM_FILES: hits += exact_npm(text,f,aff)
            if f in PY_FILES or f.startswith('requirements'): hits += exact_py(text,f,aff)
            if hits: rr['exact_affected_hits'].append({'path':path,'hits':hits})
            mh=text_hits(text,terms); wh=text_hits(text,workflow_terms)
            if mh: rr['malware_ioc_hits'].append({'path':path,'hits':mh})
            if wh: rr['workflow_risk_hits'].append({'path':path,'hits':wh})
    except Exception as e: rr['errors'].append({'stage':'tree','error':str(e)})
    return rr

def main():
    ap=argparse.ArgumentParser(); ap.add_argument('--org',required=True); ap.add_argument('--token'); ap.add_argument('--token-env',default='GITHUB_TOKEN'); ap.add_argument('--env-file'); ap.add_argument('--iocs'); ap.add_argument('--affected-packages'); ap.add_argument('--output',default='github_org_scan_results.json'); ap.add_argument('--search-output',default='github_org_code_search_results.json'); ap.add_argument('--parallel',type=int,default=4)
    args=ap.parse_args(); gh=GH(load_token(args)); iocs=load_iocs(args.iocs); aff=load_affected(args.affected_packages)
    terms=[]
    for k in ['text_iocs','file_names','domains','urls','suspicious_authors']: terms += iocs.get(k,[]) or []
    terms += (iocs.get('hashes',{}) or {}).get('sha256',[]); workflow_terms=iocs.get('workflow_risk_terms',[]) or []
    repos=[]; page=1
    while True:
        d=gh.get(f'https://api.github.com/orgs/{args.org}/repos?per_page=100&page={page}')
        if not d: break
        repos+=d; page+=1
    search={}
    for q in terms[:25]:
        try:
            d=gh.get(f'https://api.github.com/search/code?q={urllib.parse.quote(q+" org:"+args.org)}&per_page=100'); search[q]={'total_count':d.get('total_count'), 'items':[{'repository':it['repository']['full_name'],'path':it['path'],'html_url':it.get('html_url')} for it in d.get('items',[])]}
        except Exception as e: search[q]={'error':str(e)}
        time.sleep(2.1)
    Path(args.search_output).write_text(json.dumps(search,indent=2))
    results=[]
    with ThreadPoolExecutor(max_workers=args.parallel) as ex:
        for fut in as_completed([ex.submit(scan_repo,gh,args.org,r,aff,iocs,terms,workflow_terms) for r in repos]): results.append(fut.result())
    results.sort(key=lambda r:r['repo'].lower())
    summary={'repo_count':len(results),'total_candidate_files':sum(r['candidate_files'] for r in results),'repos_with_exact_affected_hits':[r['repo'] for r in results if r['exact_affected_hits']],'repos_with_malware_ioc_hits':[r['repo'] for r in results if r['malware_ioc_hits']],'repos_with_workflow_risk_hits':[r['repo'] for r in results if r['workflow_risk_hits']],'repos_with_errors':[r['repo'] for r in results if r['errors']],'truncated_trees':[r['repo'] for r in results if r['tree_truncated']]}
    Path(args.output).write_text(json.dumps({'summary':summary,'results':results},indent=2)); print(json.dumps(summary,indent=2))
if __name__=='__main__': main()
