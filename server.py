#!/usr/bin/env python3
"""Loopback-only classroom server. It has no physical robot client or network discovery."""
import argparse,json,mimetypes,time,threading
from http.server import ThreadingHTTPServer,BaseHTTPRequestHandler
from pathlib import Path
from urllib.parse import urlsplit,unquote
ROOT=Path(__file__).resolve().parent
WEB=ROOT/'web'
class Handler(BaseHTTPRequestHandler):
 def log_message(self,*args): pass # No webcam/client data in access logs.
 def valid_host(self):
  return self.headers.get('Host') in (f'127.0.0.1:{self.server.server_port}',f'localhost:{self.server.server_port}')
 def reply(self,status,body,kind='application/json'):
  self.send_response(status);self.send_header('Content-Type',kind);self.send_header('Content-Length',str(len(body)));self.send_header('X-Content-Type-Options','nosniff');self.send_header('Cache-Control','no-store');self.send_header('Referrer-Policy','no-referrer');self.send_header('Cross-Origin-Resource-Policy','same-origin');self.end_headers();self.wfile.write(body)
 def do_GET(self):
  if not self.valid_host():return self.reply(403,b'{"error":"invalid host"}')
  p=unquote(urlsplit(self.path).path)
  if p=='/api/status':return self.reply(200,json.dumps({'mujoco':self.server.sim is not None,'hardware':False}).encode())
  if p=='/api/frame.jpg' and self.server.sim:
   data=self.server.sim.frame()
   return self.reply(200,data,'image/jpeg') if data else self.reply(503,b'{"error":"sim starting"}')
  target=(WEB/p.lstrip('/')).resolve()
  if not target.is_relative_to(WEB.resolve()) or any(x.startswith('.') for x in Path(p).parts if x!='/'):return self.reply(403,b'{}')
  if target.is_dir():target=target/'index.html'
  if not target.is_file():return self.reply(404,b'{}')
  kind=mimetypes.guess_type(target)[0] or 'application/octet-stream'
  if target.suffix in ('.mjs','.js'):kind='text/javascript'
  self.reply(200,target.read_bytes(),kind)
 def do_POST(self):
  expected={f'http://127.0.0.1:{self.server.server_port}',f'http://localhost:{self.server.server_port}'}
  if not self.valid_host() or self.headers.get('Origin') not in expected:return self.reply(403,b'{"error":"same origin required"}')
  if self.path!='/api/target' or not self.server.sim:return self.reply(404,b'{}')
  try:
   size=int(self.headers.get('Content-Length','0'))
   if size<=0 or size>2048 or self.headers.get('Content-Type')!='application/json':raise ValueError('payload')
   data=json.loads(self.rfile.read(size));self.server.sim.target(data)
  except (ValueError,TypeError,KeyError):return self.reply(400,b'{"error":"invalid bounded target"}')
  self.reply(200,b'{"ok":true}')
def run():
 parser=argparse.ArgumentParser();parser.add_argument('--port',type=int,default=8099);args=parser.parse_args();args.mujoco=False
 sim=None
 if args.mujoco:
  from simulator import Simulator
  sim=Simulator();sim.start()
 server=ThreadingHTTPServer(('127.0.0.1',args.port),Handler);server.sim=sim
 print(f'Open http://127.0.0.1:{args.port} — simulation only',flush=True)
 try:server.serve_forever()
 except KeyboardInterrupt:pass
 finally:
  server.server_close()
  if sim:sim.close()
if __name__=='__main__':run()
