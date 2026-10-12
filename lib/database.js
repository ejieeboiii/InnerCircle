const { AsyncLocalStorage } = require('node:async_hooks');
const path = require('node:path');
const fs = require('node:fs');

// All callers use async queries, both for local SQLite and remote libSQL.
// Serialize local operations so async transactions cannot interleave on one connection.
function createDatabase({ url=process.env.TURSO_DATABASE_URL, token=process.env.TURSO_AUTH_TOKEN,
  filename=path.join(process.env.INNERCIRCLE_DATA_DIR || path.join(__dirname,'..','data'),'innercircle.db') } = {}) {
  if (process.env.VERCEL && (!url || !token || url.startsWith('file:'))) throw Error('Vercel requires a remote TURSO_DATABASE_URL and TURSO_AUTH_TOKEN. Local SQLite is disabled on Vercel.');
  if ((!url && token) || (url && !url.startsWith('file:') && !token)) throw Error('Configure both TURSO_DATABASE_URL and TURSO_AUTH_TOKEN.');
  const remote=!!url;
  let client;
  if(remote)client=require('@libsql/client').createClient({url,authToken:token});
  else {
    fs.mkdirSync(path.dirname(filename),{recursive:true});
    client=new (require('better-sqlite3'))(filename);
    client.pragma('journal_mode = WAL');client.pragma('busy_timeout = 5000');
  }
  const context=new AsyncLocalStorage();
  let queue=Promise.resolve();
  function serialized(action){const result=queue.then(action);queue=result.catch(()=>{});return result;}
  async function execute(sql,args=[]){
    const tx=context.getStore();
    if(remote){const result=await (tx || client).execute({sql,args});return {rows:Array.from(result.rows,r=>({...r})),changes:result.rowsAffected,lastInsertRowid:Number(result.lastInsertRowid || 0)};}
    const action=()=>{
      const stmt=client.prepare(sql);
      if(stmt.reader)return {rows:Array.isArray(args)?stmt.all(...args):stmt.all(args)};
      return Array.isArray(args)?stmt.run(...args):stmt.run(args);
    };
    return tx ? action() : serialized(action);
  }
  function prepare(sql){return {
    async all(...args){return (await execute(sql,args.length===1 && typeof args[0]==='object' && !Array.isArray(args[0]) ? args[0] : args)).rows;},
    async get(...args){return (await this.all(...args))[0];},
    async run(...args){return execute(sql,args.length===1 && typeof args[0]==='object' && !Array.isArray(args[0]) ? args[0] : args);},
  };}
  async function exec(sql){
    const tx=context.getStore();
    if(remote)return (tx || client).executeMultiple(sql);
    return tx ? client.exec(sql) : serialized(()=>client.exec(sql));
  }
  function transaction(action){return async()=>{
    if(context.getStore())return action();
    if(remote){
      const tx=await client.transaction('write');
      try{const result=await context.run(tx,action);await tx.commit();return result;}catch(err){await tx.rollback().catch(()=>{});throw err;}finally{tx.close();}
    }
    return serialized(async()=>{
      client.exec('BEGIN IMMEDIATE');
      try{const result=await context.run(client,action);client.exec('COMMIT');return result;}catch(err){client.exec('ROLLBACK');throw err;}
    });
  };}
  return {prepare,exec,transaction,remote,close:()=>client.close()};
}
module.exports={createDatabase};
