const crypto=require('node:crypto');
const {Readable}=require('node:stream');
const TYPES=new Map([['image/jpeg','.jpg'],['image/png','.png'],['image/webp','.webp'],['image/gif','.gif'],['video/mp4','.mp4'],['video/webm','.webm']]);
const MAX_SIZE=20*1024*1024;
function createStorage(db,banned,{blob,client}={}){
  const cloud=!!process.env.BLOB_READ_WRITE_TOKEN || !!blob;
  function sdk(){return blob || require('@vercel/blob');}
  async function ticket(id,device){
    if(typeof id!=='string' || id.length>100)throw Error('Invalid upload ticket.');
    const row=await db.prepare('SELECT * FROM upload_tickets WHERE id=? AND device_id=?').get(id,device);
    if(!row || row.expires_at<Date.now() || await banned(device))throw Error('Upload ticket expired or access was removed.');
    return row;
  }
  async function prepare(device,type,size){
    if(!cloud)throw Error('Private Blob storage is not configured.');
    if(!TYPES.has(type) || !Number.isSafeInteger(size) || size<1 || size>MAX_SIZE)throw Error('Choose a supported image/video up to 20 MB.');
    const member=await db.prepare('SELECT member_name FROM devices WHERE id=?').get(device);
    if(!member?.member_name || await banned(device))throw Error('Join the chat before uploading.');
    const id=crypto.randomUUID(),filename=crypto.randomUUID()+TYPES.get(type);
    const row={id,device_id:device,url:'/uploads/'+filename,pathname:'media/'+filename,content_type:type,size,expires_at:Date.now()+15*60000};
    await db.prepare('INSERT INTO upload_tickets (id,device_id,url,pathname,content_type,size,expires_at) VALUES (@id,@device_id,@url,@pathname,@content_type,@size,@expires_at)').run(row);
    return {id,pathname:row.pathname,url:row.url,kind:type.startsWith('image/')?'image':'video'};
  }
  async function finish(id,device){
    const row=await ticket(id,device);
    // Look up a server-generated path, never a URL supplied by the browser.
    const blob=await sdk().head(row.pathname);
    if(blob.pathname!==row.pathname || blob.size!==row.size || blob.contentType!==row.content_type)throw Error('Uploaded media does not match its authorized ticket.');
    await db.transaction(async()=>{
      await ticket(id,device);
      await db.prepare('INSERT OR IGNORE INTO media_objects (url,pathname,content_type,size) VALUES (?,?,?,?)').run(row.url,row.pathname,row.content_type,row.size);
      await db.prepare('INSERT OR IGNORE INTO media_uploads (url,device_id,kind) VALUES (?,?,?)').run(row.url,device,row.content_type.startsWith('image/')?'image':'video');
      await db.prepare('UPDATE upload_tickets SET completed_at=? WHERE id=?').run(Date.now(),id);
    })();
    return {url:row.url,kind:row.content_type.startsWith('image/')?'image':'video'};
  }
  async function handle(req){
    const {handleUpload}=client || require('@vercel/blob/client');
    return handleUpload({request:req,body:req.body,
      onBeforeGenerateToken:async(pathname,clientPayload)=>{
        const row=await ticket(JSON.parse(clientPayload || '{}').id,req.device);
        if(pathname!==row.pathname || row.completed_at)throw Error('Invalid upload path.');
        return {allowedContentTypes:[row.content_type],maximumSizeInBytes:row.size,validUntil:Math.min(row.expires_at,Date.now()+10*60000),addRandomSuffix:false,allowOverwrite:false,tokenPayload:JSON.stringify({id:row.id,device:row.device_id})};
      },
      // SDK verifies this server-to-server callback signature before invoking us.
      onUploadCompleted:async({tokenPayload})=>{const payload=JSON.parse(tokenPayload || '{}');await finish(payload.id,payload.device);},
    });
  }
  async function stream(req,res,object,stillAllowed){
    let start=0,end=object.size-1;
    if(req.headers.range){
      const match=/^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
      if(!match || (!match[1]&&!match[2]))return res.status(416).set('Content-Range','bytes */'+object.size).end();
      if(!match[1])start=Math.max(0,object.size-Number(match[2]));
      else{start=Number(match[1]);if(match[2])end=Math.min(end,Number(match[2]));}
      if(!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start>end || start>=object.size)return res.status(416).set('Content-Range','bytes */'+object.size).end();
    }
    const abort=new AbortController();res.once('close',()=>abort.abort());
    const result=await sdk().get(object.pathname,{access:'private',useCache:false,abortSignal:abort.signal});
    if(!result || result.statusCode!==200)return res.sendStatus(404);
    if(result.blob.size!==object.size || result.blob.contentType!==object.content_type || !await stillAllowed()){await result.stream.cancel();return res.sendStatus(404);}
    res.set({'Content-Type':object.content_type,'Content-Length':String(end-start+1),'Accept-Ranges':'bytes','Content-Disposition':'inline'});
    if(req.headers.range)res.status(206).set('Content-Range',`bytes ${start}-${end}/${object.size}`);
    if(req.method==='HEAD'){await result.stream.cancel();return res.end();}
    // The SDK exposes a complete private stream; slice without buffering the file.
    const input=Readable.fromWeb(result.stream);let offset=0;
    const output=Readable.from((async function*(){for await(const chunk of input){const from=Math.max(0,start-offset),to=Math.min(chunk.length,end+1-offset);if(to>from)yield chunk.subarray(from,to);offset+=chunk.length;if(offset>end)break;}})());
    res.on('close',()=>{output.destroy();input.destroy();});
    output.on('error',()=>res.destroy());output.pipe(res);
  }
  return {cloud,prepare,finish,handle,stream};
}
module.exports={createStorage,TYPES,MAX_SIZE};
