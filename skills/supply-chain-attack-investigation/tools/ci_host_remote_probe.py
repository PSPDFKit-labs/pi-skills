#!/usr/bin/env python3
"""Read-only remote host IOC probe template. Edit IOC lists per incident before use."""
import datetime as dt, hashlib, json, os, pwd, shlex, socket, subprocess
from pathlib import Path
COLLECTOR_VERSION='generic-1'
TEXT_IOCS=['EDIT_ME_malicious_domain_or_string']
FILE_NAMES=['EDIT_ME_payload.js']
SUSPICIOUS_AUTHORS=[]
PERSISTENCE_PATHS=['.claude','.vscode/settings.json','.vscode/tasks.json']
SEARCH_ROOTS=['/usr/lib','/usr/local/lib','/opt','/var/lib','/var/cache','/var/tmp','/tmp','/root','/home','/Users']
TEXT_GREP_PATHS=['/var/log','/var/lib/buildkite-agent','/etc/buildkite-agent','/home','/Users','/opt','/tmp','/var/tmp']

def run(cmd,shell=False,timeout=30):
    try:
        p=subprocess.run(cmd,shell=shell,text=True,capture_output=True,timeout=timeout,check=False)
        return {'returncode':p.returncode,'stdout':p.stdout.strip(),'stderr':p.stderr.strip()}
    except Exception as e: return {'returncode':999,'stdout':'','stderr':str(e)}
def lines(s): return [x for x in (s or '').splitlines() if x.strip()]
def existing(paths): return [p for p in paths if os.path.exists(p)]
def homes():
    out=set()
    for e in pwd.getpwall():
        if (e.pw_uid==0 or e.pw_uid>=500) and e.pw_dir and os.path.isdir(e.pw_dir): out.add(e.pw_dir)
    return sorted(out)
def find_files():
    roots=existing(SEARCH_ROOTS)
    if not roots or not FILE_NAMES: return []
    expr=' -o '.join(f'-name {shlex.quote(n)}' for n in FILE_NAMES)
    return lines(run(f"find {' '.join(shlex.quote(r) for r in roots)} -type f \\( {expr} \\) 2>/dev/null | head -500",shell=True,timeout=120)['stdout'])
def hash_files(paths):
    out=[]
    for p in paths[:500]:
        try:
            h=hashlib.sha256()
            with open(p,'rb') as f:
                for c in iter(lambda:f.read(1024*1024),b''): h.update(c)
            out.append({'path':p,'sha256':h.hexdigest()})
        except Exception as e: out.append({'path':p,'error':str(e)})
    return out
def grep_iocs():
    paths=existing(TEXT_GREP_PATHS); out=[]
    if not paths: return out
    for pat in TEXT_IOCS:
        if not pat or pat.startswith('EDIT_ME'): continue
        cmd='grep -R -n -I -F --binary-files=without-match -- {} {} 2>/dev/null | head -100'.format(shlex.quote(pat),' '.join(shlex.quote(p) for p in paths))
        for m in lines(run(cmd,shell=True,timeout=60)['stdout']): out.append({'pattern':pat,'match':m[:1000]})
    return out
def persistence(user_homes):
    targets=[]; hits=[]
    for h in user_homes:
        for rel in PERSISTENCE_PATHS:
            p=os.path.join(h,rel)
            if os.path.exists(p): targets.append(p)
    for t in targets:
        if os.path.isdir(t):
            for f in lines(run(f'find {shlex.quote(t)} -maxdepth 3 -type f 2>/dev/null | head -200',shell=True,timeout=20)['stdout']):
                if os.path.basename(f) in FILE_NAMES: hits.append({'type':'suspicious_file','path':f})
        else:
            try:
                text=Path(t).read_text(errors='ignore')
                for pat in TEXT_IOCS:
                    if pat and not pat.startswith('EDIT_ME') and pat in text: hits.append({'type':'text_match','path':t,'pattern':pat})
            except Exception: pass
    return {'targets_present':targets,'hits':hits}
def git_author_hits():
    roots=existing(['/home','/Users','/var/lib/buildkite-agent','/opt']); out=[]
    if not roots or not SUSPICIOUS_AUTHORS: return out
    repos=[g[:-5] for g in lines(run(f"find {' '.join(shlex.quote(r) for r in roots)} -name .git -type d 2>/dev/null | head -500",shell=True,timeout=60)['stdout']) if g.endswith('/.git')]
    for repo in repos:
        for author in SUSPICIOUS_AUTHORS:
            for l in lines(run(['git','-C',repo,'log','--all',f'--author={author}','--format=%H %aI %an <%ae> %s'],timeout=30)['stdout']): out.append({'repo':repo,'author':author,'commit':l})
    return out[:1000]
def main():
    hs=homes(); files=find_files(); payload={'host':{'collector_version':COLLECTOR_VERSION,'utc_time':dt.datetime.now(dt.timezone.utc).isoformat(),'hostname':run(['hostname'])['stdout'],'socket_hostname':socket.gethostname(),'uname':run(['uname','-a'])['stdout'],'whoami':run(['whoami'])['stdout']},'user_homes':hs,'ioc_file_paths':files,'ioc_file_hashes':hash_files(files),'ioc_text_hits':grep_iocs(),'persistence':persistence(hs),'suspicious_git_author_hits':git_author_hits(),'flags':[]}
    if payload['ioc_file_paths']: payload['flags'].append('ioc_file_paths_present')
    if payload['ioc_text_hits']: payload['flags'].append('ioc_text_hits_present')
    if payload['persistence']['hits']: payload['flags'].append('persistence_hits_present')
    if payload['suspicious_git_author_hits']: payload['flags'].append('suspicious_git_author_hits_present')
    print(json.dumps(payload,sort_keys=True))
if __name__=='__main__': main()
