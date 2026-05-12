#!/usr/bin/env python3
"""Generic local repository supply-chain IOC scanner.

Starter tool for the supply-chain-attack-investigation skill. Adapt per incident.
"""
import argparse, csv, json, os, re, subprocess
from pathlib import Path

SKIP_DIRS={'.git','node_modules','.pnpm-store','vendor','dist','build','.next','coverage','target','Pods','.venv','venv','__pycache__'}
NPM_FILES={'package.json','package-lock.json','npm-shrinkwrap.json','pnpm-lock.yaml','yarn.lock','bun.lock','bun.lockb'}
PY_FILES={'pyproject.toml','poetry.lock','uv.lock','Pipfile','Pipfile.lock','setup.py','setup.cfg'}
CI_MARKERS=['/.github/workflows/','/.buildkite/','/ci/','/scripts/']

def load_iocs(path):
    if not path: return {}
    return json.loads(Path(path).read_text())

def load_affected(path):
    out={}
    if not path: return out
    with open(path,newline='',encoding='utf-8',errors='ignore') as f:
        for r in csv.DictReader(f):
            eco=(r.get('Ecosystem') or r.get('ecosystem') or '').strip().lower()
            ns=(r.get('Namespace') or r.get('namespace') or '').strip()
            name=(r.get('Name') or r.get('name') or r.get('Package') or r.get('package') or '').strip()
            ver=(r.get('Version') or r.get('version') or '').strip()
            if not eco or not name or not ver: continue
            full=f'{ns}/{name}' if eco=='npm' and ns else name
            if eco=='pypi': full=full.lower().replace('_','-')
            out.setdefault(eco,{}).setdefault(full,set()).add(ver)
    return out

def git_remote(repo):
    try: url=subprocess.check_output(['git','-C',str(repo),'remote','get-url','origin'],text=True,stderr=subprocess.DEVNULL).strip()
    except Exception: return {'remote':'','display':repo.name}
    m=re.search(r'github\.com[:/]([^/]+)/([^/.]+)(?:\.git)?$',url)
    return {'remote':url,'display':f'{m.group(1)}/{m.group(2)}' if m else url}

def discover_roots(roots, recursive):
    repos=[]
    for root in [Path(r).expanduser().resolve() for r in roots]:
        if (root/'.git').exists(): repos.append(root); continue
        if recursive:
            for cur,dirs,files in os.walk(root):
                dirs[:]=[d for d in dirs if d not in SKIP_DIRS]
                p=Path(cur)
                if (p/'.git').exists():
                    repos.append(p); dirs[:]=[]
        else:
            repos += [p for p in root.iterdir() if p.is_dir() and (p/'.git').exists()]
    seen=[]
    for r in repos:
        if r not in seen: seen.append(r)
    return seen

def interesting(path, iocs):
    n=path.name; s='/'+str(path).replace(os.sep,'/')
    if n in NPM_FILES or n in PY_FILES or n.startswith('requirements') or n.startswith('Dockerfile'): return True
    if any(m in s for m in CI_MARKERS): return n.endswith(('.yml','.yaml','.json','.toml','.lock','.txt','.in','.sh','.js','.mjs','.cjs')) or n.startswith('Dockerfile')
    for p in iocs.get('persistence_paths',[]):
        if p.strip('/').lower() in s.lower(): return True
    return False

def exact_npm(text, fname, aff):
    hits=[]; npm=aff.get('npm',{})
    if not npm: return hits
    if fname in ('package-lock.json','npm-shrinkwrap.json'):
        try:
            for path,meta in (json.loads(text).get('packages') or {}).items():
                if path.startswith('node_modules/'):
                    name=path[len('node_modules/'):]; ver=str(meta.get('version',''))
                    if name in npm and ver in npm[name]: hits.append({'ecosystem':'npm','package':name,'version':ver,'evidence':'package-lock packages entry'})
        except Exception: pass
    elif fname=='pnpm-lock.yaml':
        for name,vers in npm.items():
            esc=re.escape(name)
            for ver in vers:
                if re.search(rf'(^|\n)\s{{2,}}/?{esc}@{re.escape(ver)}(?=\(|:|\n)', text): hits.append({'ecosystem':'npm','package':name,'version':ver,'evidence':'pnpm lock package key'})
    elif fname=='package.json':
        try:
            d=json.loads(text)
            for sec in ['dependencies','devDependencies','optionalDependencies','peerDependencies']:
                for name,spec in (d.get(sec) or {}).items():
                    if name in npm:
                        for ver in npm[name]:
                            if ver in str(spec) or str(spec).strip()=='*': hits.append({'ecosystem':'npm','package':name,'version':ver,'specifier':spec,'evidence':f'package.json {sec}'})
        except Exception: pass
    return hits

def exact_py(text, fname, aff):
    hits=[]; py=aff.get('pypi',{})
    for name,vers in py.items():
        esc=re.escape(name).replace('\\-','[-_]')
        for ver in vers:
            if re.search(rf'(?im)^\s*{esc}\s*(==|=)\s*["\']?{re.escape(ver)}\b', text) or (fname=='poetry.lock' and re.search(rf'(?is)name\s*=\s*["\']{esc}["\'].*?version\s*=\s*["\']{re.escape(ver)}["\']', text)):
                hits.append({'ecosystem':'pypi','package':name,'version':ver,'evidence':fname})
    return hits

def text_hits(text, terms):
    out=[]
    for i,line in enumerate(text.splitlines(),1):
        low=line.lower()
        for t in terms:
            if t and t.lower() in low: out.append({'line':i,'term':t,'text':line[:500]})
    return out

def scan_repo(repo, aff, iocs):
    meta=git_remote(repo); rr={'repo':meta['display'],'remote':meta['remote'],'files_scanned':0,'exact_affected_hits':[],'malware_ioc_hits':[],'workflow_risk_hits':[],'errors':[]}
    terms=[]
    for k in ['text_iocs','file_names','domains','urls','suspicious_authors']:
        terms += iocs.get(k,[]) or []
    terms += (iocs.get('hashes',{}) or {}).get('sha256',[])
    wr=iocs.get('workflow_risk_terms',[]) or []
    for root,dirs,files in os.walk(repo):
        dirs[:]=[d for d in dirs if d not in SKIP_DIRS]
        for f in files:
            p=Path(root)/f
            if not interesting(p,iocs): continue
            rr['files_scanned']+=1; rel=str(p.relative_to(repo))
            try: text=p.read_text(errors='ignore')
            except Exception as e: rr['errors'].append({'path':rel,'error':str(e)}); continue
            hits=[]
            if f in NPM_FILES: hits += exact_npm(text,f,aff)
            if f in PY_FILES or f.startswith('requirements'): hits += exact_py(text,f,aff)
            if hits: rr['exact_affected_hits'].append({'path':rel,'hits':hits})
            mh=text_hits(text,terms); wh=text_hits(text,wr)
            if mh: rr['malware_ioc_hits'].append({'path':rel,'hits':mh})
            if wh: rr['workflow_risk_hits'].append({'path':rel,'hits':wh})
    return rr

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument('--repo-root', action='append', required=True)
    ap.add_argument('--recursive', action='store_true')
    ap.add_argument('--iocs')
    ap.add_argument('--affected-packages')
    ap.add_argument('--output', default='local_repo_scan_results.json')
    args=ap.parse_args()
    iocs=load_iocs(args.iocs); aff=load_affected(args.affected_packages)
    results=[scan_repo(r,aff,iocs) for r in discover_roots(args.repo_root,args.recursive)]
    summary={'repos_scanned':len(results),'files_scanned':sum(r['files_scanned'] for r in results),'repos_with_exact_affected_hits':[r['repo'] for r in results if r['exact_affected_hits']],'repos_with_malware_ioc_hits':[r['repo'] for r in results if r['malware_ioc_hits']],'repos_with_workflow_risk_hits':[r['repo'] for r in results if r['workflow_risk_hits']]}
    Path(args.output).write_text(json.dumps({'summary':summary,'results':results},indent=2))
    print(json.dumps(summary,indent=2))
if __name__=='__main__': main()
