// Run against an isolated test server: node tests/deletion.js http://127.0.0.1:3100
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
let base = process.argv[2];
let child;
let fixture;
async function launch(){
  child=spawn(process.execPath,['server.js'],{cwd:path.join(__dirname,'..'),env:{...process.env,PORT:'0',INNERCIRCLE_DATA_DIR:path.join(fixture,'data'),INNERCIRCLE_UPLOADS_DIR:path.join(fixture,'uploads')},stdio:['ignore','pipe','pipe']});
  base=await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(Error('Test server startup timed out')),10000);
    child.once('error',reject);child.once('exit',code=>reject(Error('Test server exited: '+code)));
    child.stderr.on('data',chunk=>process.stderr.write(chunk));
    child.stdout.on('data',chunk=>{const match=chunk.toString().match(/http:\/\/localhost:(\d+)/);if(match){clearTimeout(timer);resolve('http://127.0.0.1:'+match[1]);}});
  });
}
async function stop(){if(child&&!child.killed){const done=new Promise(resolve=>child.once('exit',resolve));child.kill();await done;}}
async function session(){
  const r=await fetch(base+'/api/messages');
  const cookie=r.headers.get('set-cookie').split(';')[0];
  async function request(url,options={}){return fetch(base+url,{...options,headers:{...options.headers,Cookie:cookie}});}
  async function connect(){
    // Native WebSocket cannot attach cookies; use the Socket.IO polling transport.
    const open=await request('/socket.io/?EIO=4&transport=polling');
    const sid=JSON.parse((await open.text()).slice(1)).sid;
    const url='/socket.io/?EIO=4&transport=polling&sid='+sid;
    const queue=[];let running=true;let failure;
    async function send(packet){const r=await request(url,{method:'POST',body:packet,headers:{'Content-Type':'text/plain'}});assert.equal(r.status,200);}
    const pump=(async()=>{while(running){try{const r=await request(url);for(const p of (await r.text()).split('\x1e')){if(p==='2')await send('3');else queue.push(p);}}catch(e){failure=e;break;}}})();
    async function wait(predicate){for(let i=0;i<200;i++){const n=queue.findIndex(predicate);if(n>=0)return queue.splice(n,1)[0];if(failure)throw failure;await new Promise(r=>setTimeout(r,25));}throw Error('Socket event timed out');}
    await send('40');await wait(p=>p.startsWith('40'));
    await send('42'+JSON.stringify(['join','Same name']));
    let ack=0;
    return {async emit(event,payload){await send('42'+JSON.stringify([event,payload]));},
      async event(event){const p=await wait(p=>p.startsWith('42')&&JSON.parse(p.slice(2))[0]===event);return JSON.parse(p.slice(2))[1];},
      async remove(id,scope){const n=++ack;await send('42'+n+JSON.stringify(['delete-message',{id,scope}]));const p=await wait(p=>p.startsWith('43'+n+'['));return JSON.parse(p.slice(('43'+n).length))[0];},
      async close(){running=false;await send('41');await send('1');await pump;}};
  }
  return {request,connect,async history(){return (await request('/api/messages')).json();}};
}
(async()=>{
  if(!base){
    fixture=fs.mkdtempSync(path.join(os.tmpdir(),'innercircle-deletion-'));
    fs.mkdirSync(path.join(fixture,'data'));
    const legacy=new Database(path.join(fixture,'data','innercircle.db'));
    legacy.exec('CREATE TABLE messages (id TEXT PRIMARY KEY, sender TEXT NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL)');
    legacy.prepare('INSERT INTO messages VALUES (?,?,?,?,?)').run('legacy','Same name','text','Preserved history','2025-01-01T00:00:00.000Z');legacy.close();
    await launch();
    const migrated=new Database(path.join(fixture,'data','innercircle.db'),{readonly:true});
    assert.deepEqual(migrated.prepare('SELECT * FROM messages WHERE id=?').get('legacy'),{id:'legacy',sender:'Same name',kind:'text',body:'Preserved history',created_at:'2025-01-01T00:00:00.000Z',owner_id:null,deleted_at:null,deleted_by_admin:null});migrated.close();
    console.log('PASS non-destructive legacy migration');
  }
  const a=await session(), b=await session();const sa=await a.connect(), sb=await b.connect();
  try {
    if(fixture)assert.match((await sa.remove('legacy','everyone')).error,/only delete/);
    for(const kind of ['text','image','video']){
      let body='Integration '+kind+' '+Date.now();
      if(kind!=='text'){
        const form=new FormData();form.append('media',new Blob([kind==='image'?Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64'):Buffer.from([0,0,0,24,102,116,121,112,105,115,111,109])],{type:kind==='image'?'image/png':'video/mp4'}),'fixture.'+(kind==='image'?'png':'mp4'));
        const upload=await a.request('/api/upload',{method:'POST',body:form});assert.equal(upload.status,200);body=(await upload.json()).url;
      }
      await sa.emit('chat-message',{kind,body});const m=await sa.event('chat-message');const other=await sb.event('chat-message');assert.equal(m.mine,true);assert.equal(other.mine,false);
      assert.match((await sb.remove(m.id,'everyone')).error,/only delete/);
      assert.equal((await sb.remove(m.id,'invalid')).error,'Invalid deletion request.');
      assert.equal((await sb.remove(m.id,'me')).ok,true);await sb.event('message-hidden');
      assert(!(await b.history()).some(v=>v.id===m.id));assert((await a.history()).some(v=>v.id===m.id));
      if(kind!=='text')assert.equal((await b.request(body)).status,200);
      assert.equal((await sa.remove(m.id,'everyone')).ok,true);await sa.event('message-deleted');await sb.event('message-deleted');
      const deleted=(await a.history()).find(v=>v.id===m.id);assert.equal(deleted.body,'This message was deleted.');assert.equal(deleted.kind,'text');assert.equal(deleted.deleted,true);
      assert(!(await b.history()).some(v=>v.id===m.id));
      assert.equal((await sa.remove(m.id,'everyone')).ok,true);
      if(kind!=='text'){
        assert.equal((await a.request(body)).status,404);assert.equal((await b.request(body)).status,404);
        await sa.emit('chat-message',{kind,body});
        assert.equal((await a.history()).filter(v=>v.body===body).length,0);
      }
      console.log('PASS '+kind+': private hide, persistence, ownership rejection, everyone tombstone'+(kind==='text'?'':', media blocked'));
    }
    assert.equal((await sa.remove('missing','me')).error,'Message not found.');
    const attack=await a.request('/api/messages',{headers:{Origin:'https://attacker.invalid'}});assert.equal(attack.status,403);
    await sb.close();const reconnected=await b.connect();await reconnected.close();
    console.log('PASS invalid requests, cross-origin rejection, and reconnect');
  } finally {await sa.close();try{await sb.close();}catch{}}
  if(fixture){
    const beforeA=await a.history(),beforeB=await b.history();await stop();await launch();
    assert.deepEqual(await a.history(),beforeA);assert.deepEqual(await b.history(),beforeB);
    console.log('PASS identities, hidden messages, and shared deletions survive server restart');
  }
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(stop);
