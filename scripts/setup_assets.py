#!/usr/bin/env python3
"""Download pinned public assets, validate SHA256; no code execution, no API keys."""
import hashlib,json,subprocess,tempfile
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
for a in json.loads((ROOT/'assets-manifest.json').read_text()):
 target=ROOT/a['path']
 if not target.resolve().is_relative_to(ROOT) or not a['url'].startswith('https://'):raise ValueError('unsafe manifest')
 if target.exists() and hashlib.sha256(target.read_bytes()).hexdigest()==a['sha256']:continue
 print('Downloading',a['path'],flush=True)
 target.parent.mkdir(parents=True,exist_ok=True)
 with tempfile.TemporaryDirectory() as tmp:
  part=Path(tmp)/'asset'
  subprocess.run(['curl','--fail','--location','--proto','=https','--proto-redir','=https','--retry','2','--max-time','900','-o',str(part),a['url']],check=True)
  blob=part.read_bytes()
  if len(blob)!=a['bytes'] or hashlib.sha256(blob).hexdigest()!=a['sha256']:raise ValueError('checksum mismatch: '+a['path'])
  target.write_bytes(blob)
print('Local vision assets verified. Run: python3 server.py')
