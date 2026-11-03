#!/usr/bin/env python3
"""Conservative pattern audit of tracked content/history. No matched secret values printed."""
from pathlib import Path
import re,subprocess,sys
ROOT=Path(__file__).resolve().parents[1]
def git(*a):return subprocess.check_output(['git','-C',str(ROOT),*a])
patterns={
 'private-key':rb'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----',
 'credential':rb'(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16})',
 'home-path':rb'/(?:Users|home)/[A-Za-z0-9_.-]+/',
 'private-ip':rb'\b(?:192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b',
 'device-serial':rb'usbmodem(?!CLASSROOM_DEMO)[A-Za-z0-9]{5,}',
}
issues=[];paths=git('ls-files','-z').decode().split('\0')
for name in filter(None,paths):
 p=ROOT/name
 if any(x in {'.env','.venv','recordings','local-data','calibration','vault'} for x in p.relative_to(ROOT).parts):issues.append((name,'forbidden path'))
 if p.is_symlink():issues.append((name,'symlink'))
 if not p.is_file():continue
 b=p.read_bytes()
 if name.endswith('audit_public.py'):continue # this scanner intentionally contains signatures
 for label,pat in patterns.items():
  if re.search(pat,b):issues.append((name,label))
# Search committed blobs, not only working files. Object identifiers are safe to print.
try:objects=git('rev-list','--objects','--all').decode().splitlines()
except subprocess.CalledProcessError:objects=[]
for row in objects:
 parts=row.split(' ',1);oid=parts[0];path=parts[1]if len(parts)>1 else ''
 if path.endswith('audit_public.py'):continue
 if git('cat-file','-t',oid).strip()!=b'blob':continue
 b=git('cat-file','-p',oid)
 for label,pat in patterns.items():
  if re.search(pat,b):issues.append(('history:'+oid[:12],label))
for path,label in issues:print(label,path)
print('AUDIT', 'FAIL'if issues else 'PASS', 'tracked files:',len([p for p in paths if p]),'findings:',len(issues))
sys.exit(bool(issues))
