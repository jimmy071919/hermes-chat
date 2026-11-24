const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../public/app.js'), 'utf8');
const code = source.slice(source.indexOf('async function send()'), source.indexOf('// ---------- approvals'));
function setup() {
  const S = { streaming: null, current: 's', attachments: [{status:'done', file:{name:'x.png'}, uploaded:{name:'x.png',path:'/workspace/x.png'}, isImage:true, modelUrl:'data:image/png;base64,AAA'}] };
  const input = {value:'hello'}, box = {append(){}}; let calls = [], texts = [], views = [], stopped = 0, saved = {};
  const ctx = { S, console, AbortController, Uint8Array, TextDecoderStream, JSON, encodeURIComponent, crypto: require('node:crypto').webcrypto,
    localStorage:{setItem(k,v){saved[k]=v},getItem(k){return saved[k]},removeItem(k){delete saved[k]}},
    $: x => x === '#input' ? input : box, ensureSession:async()=> 's',
    api:async(path)=>{ if(path.endsWith('/stop')) { stopped++; return {}; } return {status:'running'} },
    autoResize(){},clearAttachments(){S.attachments=[]},chatEl:()=>({classList:{add(){}}}), renderUser:()=>({}),
    AssistantView:class {constructor(){this.el={};this.text='';views.push(this)} setStreaming(){} setText(t){this.text=t;texts.push(t)} delta(t){this.text+=t} commentary(){} thinking(){} toolStart(){} toolEnd(){} finishTools(){} meta(){} error(t){throw Error(t)}},
    stickToBottom(){},updateSendState(){},hideApproval(){},loadSessions(){},refreshFiles(){},modelRequestFields:()=>({model:'m'}),toast(){},autoStick:false,
    setTimeout(fn){queueMicrotask(fn)},
    fetch:async(url,opts)=>{ calls.push({url,opts}); if(url==='/api/runs') return {ok:true,json:async()=>({run_id:'run_abc'})};
      const n=calls.filter(c=>c.url.includes('/events')).length;
      const events = n===1 ? 'data: {"event":"message.delta","seq":0,"delta":"one"}\n\n' : 'data: {"event":"message.delta","seq":1,"delta":" two"}\n\ndata: {"event":"run.completed","seq":2,"output":"one two"}\n\n';
      return {ok:true, body:new ReadableStream({start(c){c.enqueue(new TextEncoder().encode(events));c.close()}})};
    }, ReadableStream, TextEncoder,
  }; vm.createContext(ctx); vm.runInContext(code,ctx); return {ctx,S,calls,texts,views,saved,get stopped(){return stopped}};
}
test('admission retains image and path, disconnect replays from seq without stopping',async()=>{
 const t=setup(); await t.ctx.send(); const post=t.calls[0], body=JSON.parse(post.opts.body);
 assert.equal(body.session_id,'s'); assert.equal(body.model,'m'); assert.match(body.input[0].content[0].text,/\/workspace\/x.png/); assert.equal(body.input[0].content[1].image_url.url,'data:image/png;base64,AAA');
 assert.ok(post.opts.headers['Idempotency-Key']); assert.match(t.calls[2].url,/last_seq=0/); assert.equal(t.views[0].text,'one two'); assert.equal(t.stopped,0); assert.equal(t.S.streaming,null);
});
test('manual stop explicitly calls stop',async()=>{const t=setup(); t.S.streaming={runId:'run_abc'}; await t.ctx.stopRun(); assert.equal(t.stopped,1)});
