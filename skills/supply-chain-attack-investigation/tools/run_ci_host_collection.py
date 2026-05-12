#!/usr/bin/env python3
import argparse, concurrent.futures as cf, csv, datetime as dt, json, os, pathlib, subprocess, sys

def parse_args():
    p=argparse.ArgumentParser(description='Run a read-only supply-chain IOC remote probe over SSH.')
    p.add_argument('--csv', help='Device CSV with Device name and Tailscale IPs/IP columns')
    p.add_argument('--hosts', help='Plain host list: ip or name,ip per line')
    p.add_argument('--remote-probe', required=True)
    p.add_argument('--ssh-user', default='')
    p.add_argument('--parallel', type=int, default=10)
    p.add_argument('--timeout', type=int, default=240)
    p.add_argument('--output-dir', default='')
    p.add_argument('--match', action='append', default=[])
    p.add_argument('--limit', type=int, default=0)
    p.add_argument('--host-key-checking', default='accept-new', choices=['accept-new','yes','no'])
    p.add_argument('--dry-run', action='store_true')
    return p.parse_args()

def load_csv(path, filters):
    out=[]
    with open(path,newline='',encoding='utf-8',errors='ignore') as f:
        for r in csv.DictReader(f):
            name=(r.get('Device name') or r.get('Name') or '').strip(); ips=(r.get('Tailscale IPs') or r.get('IP') or r.get('Address') or '').split(',')
            ip=next((x.strip() for x in ips if x.strip() and ':' not in x), '')
            if name and ip and (not filters or any(f.lower() in name.lower() for f in filters)): out.append({'device_name':name,'ip':ip,'tags':(r.get('Tags') or '').strip()})
    return out

def load_hosts(path, filters):
    out=[]
    for raw in pathlib.Path(path).read_text(errors='ignore').splitlines():
        line=raw.strip()
        if not line or line.startswith('#'): continue
        name,ip=([x.strip() for x in line.split(',',1)] if ',' in line else (line,line))
        if not filters or any(f.lower() in name.lower() for f in filters): out.append({'device_name':name,'ip':ip,'tags':''})
    return out

def target(h,user): return f'{user}@{h["ip"]}' if user else h['ip']
def run_host(h,args,probe):
    cmd=['ssh','-o','BatchMode=yes','-o',f'ConnectTimeout={min(args.timeout,30)}','-o',f'StrictHostKeyChecking={args.host_key_checking}',target(h,args.ssh_user),'python3','-']
    try:
        p=subprocess.run(cmd,input=probe,text=True,capture_output=True,timeout=args.timeout,check=False)
        return h, {'returncode':p.returncode,'stdout':p.stdout,'stderr':p.stderr}
    except subprocess.TimeoutExpired as e:
        return h, {'returncode':124,'stdout':e.stdout or '', 'stderr':(e.stderr or '')+'\nSSH command timed out'}

def summarize(h,payload):
    return {'device_name':h['device_name'],'ip':h['ip'],'target_hostname':payload.get('host',{}).get('hostname',''),'reachable':'yes','ioc_file_count':str(len(payload.get('ioc_file_paths',[]))),'ioc_text_hit_count':str(len(payload.get('ioc_text_hits',[]))),'persistence_hit_count':str(len(payload.get('persistence',{}).get('hits',[]))),'suspicious_git_author_count':str(len(payload.get('suspicious_git_author_hits',[]))),'flags':';'.join(payload.get('flags',[]))}

def main():
    args=parse_args()
    if not args.csv and not args.hosts: raise SystemExit('provide --csv or --hosts')
    hosts=load_csv(args.csv,args.match) if args.csv else load_hosts(args.hosts,args.match)
    if args.limit: hosts=hosts[:args.limit]
    if args.dry_run:
        for h in hosts: print(f'{h["device_name"]},{h["ip"]},{h.get("tags","")}')
        return
    probe=pathlib.Path(args.remote_probe).read_text()
    ts=dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%SZ'); out=pathlib.Path(args.output_dir or f'ci-host-results-{ts}'); hd=out/'hosts'; hd.mkdir(parents=True,exist_ok=True)
    (out/'run_metadata.json').write_text(json.dumps({'generated_at_utc':dt.datetime.now(dt.timezone.utc).isoformat(),'csv':os.path.abspath(args.csv) if args.csv else '', 'hosts':os.path.abspath(args.hosts) if args.hosts else '', 'remote_probe':os.path.abspath(args.remote_probe),'parallel':args.parallel,'timeout':args.timeout,'host_count':len(hosts),'filters':args.match},indent=2))
    summaries=[]; failures=[]
    with cf.ThreadPoolExecutor(max_workers=args.parallel) as pool:
        for fut in cf.as_completed([pool.submit(run_host,h,args,probe) for h in hosts]):
            h,res=fut.result(); stem=f'{h["device_name"]}__{h["ip"].replace(".","_").replace(":","_")}'
            if res['returncode']==0:
                try:
                    payload=json.loads(res['stdout']); (hd/f'{stem}.json').write_text(json.dumps(payload,indent=2,sort_keys=True)); row=summarize(h,payload); summaries.append(row); print(f'[ok] {h["device_name"]} {h["ip"]} flags={row["flags"] or "-"}')
                except Exception as e:
                    failures.append({**h,'error':f'failed to parse JSON: {e}','stderr':res['stderr']}); (hd/f'{stem}.stdout.txt').write_text(res['stdout']); (hd/f'{stem}.stderr.txt').write_text(res['stderr']); print(f'[bad-json] {h["device_name"]} {h["ip"]}',file=sys.stderr)
            else:
                failures.append({**h,'error':f'ssh return code {res["returncode"]}','stderr':res['stderr']}); (hd/f'{stem}.stderr.txt').write_text(res['stderr']); print(f'[fail] {h["device_name"]} {h["ip"]}',file=sys.stderr)
    fields=['device_name','ip','target_hostname','reachable','ioc_file_count','ioc_text_hit_count','persistence_hit_count','suspicious_git_author_count','flags']
    with open(out/'summary.csv','w',newline='') as f:
        w=csv.DictWriter(f,fieldnames=fields); w.writeheader(); w.writerows(sorted(summaries,key=lambda r:r['device_name']))
    (out/'summary.json').write_text(json.dumps(sorted(summaries,key=lambda r:r['device_name']),indent=2)); (out/'failures.json').write_text(json.dumps(failures,indent=2))
    print(f'\nCompleted. Successes: {len(summaries)}  Failures: {len(failures)}\nResults written to: {out}')
if __name__=='__main__': main()
