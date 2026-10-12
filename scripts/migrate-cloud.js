const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const Database=require('better-sqlite3');
const {createDatabase}=require('../lib/database');
const {migrate}=require('../lib/schema');
const {TYPES,MAX_SIZE}=require('../lib/storage');
const TABLES=['messages','devices','message_hidden','media_uploads','admin_accounts','admin_sessions','member_bans','message_moderation','admin_login_attempts','media_objects'];
class MigrationError extends Error {}
const quote=name=>'"'+name.replaceAll('"','""')+'"';
function option(name,fallback){const at=process.argv.indexOf(name);return at<0?fallback:process.argv[at+1];}
async function run({blobProvider}={}){
  const apply=process.argv.includes('--apply');
  const sourceFile=path.resolve(option('--source',path.join(__dirname,'..','data','innercircle.db')));
  const uploads=path.resolve(option('--uploads',path.join(__dirname,'..','uploads')));
  const backups=path.resolve(option('--backup-dir',path.join(__dirname,'..','data','backups')));
  if(!fs.existsSync(sourceFile))throw new MigrationError('Source database does not exist.');
  if(apply && (!process.env.TURSO_DATABASE_URL || !process.env.TURSO_AUTH_TOKEN || !process.env.BLOB_READ_WRITE_TOKEN))throw new MigrationError('Apply requires TURSO_DATABASE_URL, TURSO_AUTH_TOKEN and a private BLOB_READ_WRITE_TOKEN.');
  fs.mkdirSync(backups,{recursive:true});
  const snapshot=path.join(backups,'before-cloud-'+Date.now()+'-'+crypto.randomUUID()+'.db');
  const original=new Database(sourceFile,{readonly:true});
  try{await original.backup(snapshot);}finally{original.close();}
  // Upgrade only the snapshot. The original database stays untouched.
  const copy=createDatabase({url:'',token:'',filename:snapshot});await migrate(copy);copy.close();
  const local=new Database(snapshot,{readonly:true});
  const data={};
  for(const table of TABLES)data[table]=local.prepare(`SELECT ${table==='messages'?'rowid AS _migration_rowid,':''}* FROM ${quote(table)} ORDER BY rowid`).all();
  local.close();
  const fingerprint=crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex');
  const extensionTypes=new Map([...TYPES].map(([type,extension])=>[extension,type]));
  const deletedOnly=new Set(data.messages.filter(m=>m.kind!=='text' && m.deleted_at).map(m=>m.body));
  for(const m of data.messages)if(m.kind!=='text' && !/^\/uploads\/[a-f0-9-]{36}\.(jpg|png|webp|gif|mp4|webm)$/.test(m.body))throw new MigrationError('A media record has an unsupported path. Restore a valid source database before migrating.');
  for(const m of data.messages)if(m.kind!=='text' && !m.deleted_at)deletedOnly.delete(m.body);
  const files=(fs.existsSync(uploads)?fs.readdirSync(uploads):[]).filter(name=>/^[a-f0-9-]{36}\.(jpg|png|webp|gif|mp4|webm)$/.test(name) && !deletedOnly.has('/uploads/'+name));
  for(const m of data.messages)if(m.kind!=='text' && !m.deleted_at && !data.media_objects.some(o=>o.url===m.body) && !files.includes(path.basename(m.body)))throw new MigrationError('A live message has a missing media file. Restore it before migrating.');
  console.log(JSON.stringify({mode:apply?'apply':'dry-run',backup:snapshot,records:Object.fromEntries(TABLES.map(t=>[t,data[t].length])),mediaFiles:files.length},null,2));
  if(!apply){console.log('Dry run complete. No cloud writes or original database changes were made.');return;}
  const remote=createDatabase();
  try{
    await migrate(remote);
    await remote.exec('CREATE TABLE IF NOT EXISTS migration_imports (fingerprint TEXT PRIMARY KEY,completed_at TEXT NOT NULL)');
    if(await remote.prepare('SELECT 1 FROM migration_imports WHERE fingerprint=?').get(fingerprint)){console.log('This snapshot was already imported; nothing was overwritten.');return;}
    async function empty(){for(const table of TABLES)if((await remote.prepare(`SELECT count(*) n FROM ${quote(table)}`).get()).n)throw new MigrationError('Cloud database is populated. Refusing to overwrite existing data.');}
    await empty();
    const blob=blobProvider || require('@vercel/blob');
    for(const name of files){
      const filename=path.join(uploads,name),buffer=fs.readFileSync(filename);
      if(buffer.length>MAX_SIZE)throw new MigrationError('A media file exceeds the 20 MB limit.');
      const url='/uploads/'+name,pathname='media/'+name,contentType=extensionTypes.get(path.extname(name));
      const checksum=crypto.createHash('sha256').update(buffer).digest('hex');
      let exists=false;
      try{
        const previous=await blob.get(pathname,{access:'private',useCache:false});
        if(previous){const bytes=Buffer.from(await new Response(previous.stream).arrayBuffer());if(crypto.createHash('sha256').update(bytes).digest('hex')!==checksum)throw new MigrationError('An existing Blob has different content. No file was overwritten.');exists=true;}
      }catch(err){if(!(err instanceof blob.BlobNotFoundError))throw err;}
      if(!exists)await blob.put(pathname,buffer,{access:'private',contentType,addRandomSuffix:false,allowOverwrite:false});
      const object={url,pathname,content_type:contentType,size:buffer.length,sha256:checksum};
      const index=data.media_objects.findIndex(o=>o.url===url);if(index<0)data.media_objects.push(object);else data.media_objects[index]=object;
    }
    // Verify references that were already stored remotely in the local source.
    for(const object of data.media_objects){const meta=await blob.head(object.pathname);if(meta.size!==object.size || meta.contentType!==object.content_type)throw new MigrationError('Existing private media metadata does not match.');}
    await remote.transaction(async()=>{
      await empty();
      for(const table of TABLES)for(const record of data[table]){
        const keys=Object.keys(record),columns=keys.map(k=>quote(k==='_migration_rowid'?'rowid':k));
        await remote.prepare(`INSERT INTO ${quote(table)} (${columns.join(',')}) VALUES (${keys.map(()=>'?').join(',')})`).run(...keys.map(k=>record[k]));
      }
      for(const table of TABLES)if((await remote.prepare(`SELECT count(*) n FROM ${quote(table)}`).get()).n!==data[table].length)throw new MigrationError('Migration count mismatch; import rolled back.');
      await remote.prepare('INSERT INTO migration_imports VALUES (?,?)').run(fingerprint,new Date().toISOString());
    })();
    console.log('Cloud migration verified. Original database and files were preserved. Keep the backup private.');
  }finally{remote.close();}
}
module.exports={run,MigrationError};
if(require.main===module)run().catch(error=>{console.error(error instanceof MigrationError?error.message:'Migration failed. Check configuration, missing media, and whether the target database is empty. The original data was not overwritten.');process.exitCode=1;});
