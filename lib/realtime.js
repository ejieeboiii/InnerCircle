// A shared event journal avoids broadcasts being lost when Vercel uses multiple instances.
// Payloads contain only IDs; the receiving instance reads authoritative state and permissions.
function createRealtime(db,io,dispatch){
  let cursor=0,timer,busy=false,lastMaintenance=0;
  const delivered=new Set();
  const inflight=new Map();
  async function record(type,target=null){return db.prepare('INSERT INTO realtime_events (type,target,created_at) VALUES (?,?,?)').run(type,target,Date.now());}
  async function deliver(event){
    if(event.id<=cursor || delivered.has(event.id))return;
    if(inflight.has(event.id))return inflight.get(event.id);
    const task=Promise.resolve().then(()=>dispatch(event)).then(()=>delivered.add(event.id)).finally(()=>inflight.delete(event.id));
    inflight.set(event.id,task);await task;
  }
  async function publish(type,target=null){const event=await record(type,target);await deliver({id:event.lastInsertRowid,type,target});}
  async function flush(){
    if(busy)return;busy=true;
    try{
      const events=await db.prepare('SELECT * FROM realtime_events WHERE id>? ORDER BY id LIMIT 500').all(cursor);
      for(const event of events){await deliver(event);cursor=event.id;delivered.delete(event.id);}
      if(Date.now()-lastMaintenance>20000){
        const now=Date.now();
        await db.prepare('DELETE FROM presence WHERE expires_at<?').run(now);
        for(const socket of io.sockets.sockets.values())if(socket.data.joined)await db.prepare('UPDATE presence SET expires_at=? WHERE connection_id=?').run(now+60000,socket.id);
        await db.prepare('DELETE FROM realtime_events WHERE created_at<? AND id<=?').run(now-86400000,cursor);
        lastMaintenance=now;
        await dispatch({type:'members'});
        await dispatch({type:'check-access'});
      }
    }catch(err){console.error('Real-time synchronization failed; clients will retry.');}
    finally{busy=false;}
  }
  async function start(){cursor=(await db.prepare('SELECT COALESCE(MAX(id),0) id FROM realtime_events').get()).id;}
  function watch(){if(!timer){timer=setInterval(()=>{if(io.sockets.sockets.size)void flush();},1000);timer.unref();}}
  return {start,watch,publish,record,deliver,flush};
}
module.exports={createRealtime};
