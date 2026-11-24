const {test} = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http'), {spawn} = require('node:child_process'), fs=require('node:fs'), path=require('node:path');
const sleep = ms=>new Promise(r=>setTimeout(r,ms));
test('proxy admits independently, replays after subscriber disconnect, and stops explicitly', async t=>{
 let state='running', posted, key, subscriptions=0;
 const upstream=http.createServer(async(req,res)=>{
  if (req.url==='/v1/runs' && req.method==='POST') {let chunks=[]; for await(const c of req) chunks.push(c); posted=JSON.parse(Buffer.concat(chunks)); key=req.headers['idempotency-key']; res.writeHead(202,{'content-type':'application/json'}); return res.end(JSON.stringify({run_id:'run_123',status:state}));}
  if(req.url.startsWith('/v1/runs/run_123/events')) {subscriptions++; res.writeHead(200,{'content-type':'text/event-stream'}); res.write('data: '+JSON.stringify({event:'message.delta',seq:0,delta:'first'})+'\n\n'); if(req.url.includes('last_seq=0')) res.end('data: '+JSON.stringify({event:'run.completed',seq:1,output:'finished'})+'\n\n'); return;}
  if(req.url==='/v1/runs/run_123/stop'){state='cancelled';res.writeHead(200,{'content-type':'application/json'});return res.end('{}')}
  if(req.url==='/v1/runs/run_123'){res.writeHead(200,{'content-type':'application/json'});return res.end(JSON.stringify({status:state}))} res.writeHead(404);res.end();
 }); await new Promise(r=>upstream.listen(0,'127.0.0.1',r)); t.after(()=>upstream.closeAllConnections()); t.after(()=>upstream.close());
 const reservation=http.createServer(); await new Promise(r=>reservation.listen(0,'127.0.0.1',r)); const port=reservation.address().port; await new Promise(r=>reservation.close(r));
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'chat-test-')); t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const proc=spawn(process.execPath,['server.mjs'],{cwd:path.join(__dirname,'..'),env:{...process.env,PORT:String(port),HOST:'127.0.0.1',HERMES_URL:`http://127.0.0.1:${upstream.address().port}`,HERMES_API_KEY:'test-key',APP_PASSWORD:'',DATA_DIR:dir,HERMES_ENV_FILE:'/nonexistent',TLS_CERT_FILE:'',TLS_KEY_FILE:''},stdio:'ignore'}); t.after(()=>proc.kill());
 const base=`http://127.0.0.1:${port}`; for(let i=0;i<100;i++){try{await fetch(base+'/api/config');break}catch{await sleep(20)}}
 const response=await fetch(base+'/api/runs',{method:'POST',headers:{'content-type':'application/json','Idempotency-Key':'stable-key'},body:JSON.stringify({session_id:'session_1',input:'[附件] x — /tmp/x',model:'m'})}); assert.equal(response.status,202); assert.equal(key,'stable-key'); assert.match(posted.instructions,/Hermes Chat/); assert.match(posted.input,/附件/);
 const ac=new AbortController(); const stream=await fetch(base+'/api/runs/run_123/events?last_seq=-1',{signal:ac.signal}); const reader=stream.body.getReader(); await reader.read(); ac.abort(); await sleep(50);
 assert.equal((await (await fetch(base+'/api/runs/run_123')).json()).status,'running');
 const replay=await (await fetch(base+'/api/runs/run_123/events?last_seq=0')).text(); assert.match(replay,/finished/); assert.equal(subscriptions,2);
 assert.equal((await fetch(base+'/api/runs/run_123/stop',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status,200); assert.equal((await (await fetch(base+'/api/runs/run_123')).json()).status,'cancelled');
});
