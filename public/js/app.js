const $ = id => document.getElementById(id);
const welcome=$('welcome'),chat=$('chat'),messages=$('messages');
let name=localStorage.getItem('innercircle-name') || '';
let socket,selected,memberAction;
let role='user',csrf='',accessRevoked=false,loggingOut=false,startVersion=0;
let syncing=false,pending=[],memberData=null,adminMemberData=null,nextBefore=null,moderationLoaded=false;
let moderationLoading=false,moderationPending=[];
const history=new Map(),moderationHistory=new Map();
function saveCache(){if(!accessRevoked)localStorage.setItem('innercircle-cache',JSON.stringify([...history.values()].slice(-100)));}
function stopMedia(element){element?.querySelectorAll('video').forEach(v=>{v.pause();v.removeAttribute('src');v.load();});}
function screen(id){for(const section of ['welcome','chat','adminDashboard','removed'])$(section).classList.toggle('hidden',section!==id);}
function closeDelete(){$('deleteDialog').close();selected=null;}
function clearModeration(){stopMedia($('moderationMessages'));$('moderationMessages').replaceChildren();moderationHistory.clear();moderationLoaded=false;nextBefore=null;}
function setRole(data){
  const previousRole=role;role=data.role || 'user';csrf=role==='admin' ? data.csrf || '' : '';
  $('showAdmin').title=role==='admin'?'Admin Dashboard':'Login as Admin';if(role!=='admin')clearModeration();
  if(previousRole!==role){for(const m of [...history.values()])addMessage({...m,canDeleteEveryone:!m.deleted && (m.mine || role==='admin')});saveCache();}
}
function removed(message='You have been removed from InnerCircle.'){
  accessRevoked=true;startVersion++;socket?.disconnect();setRole({role:'user'});
  stopMedia(messages);messages.replaceChildren();history.clear();pending=[];
  localStorage.removeItem('innercircle-cache');memberData=null;adminMemberData=null;
  for(const id of ['deleteDialog','membersDialog','memberConfirm'])if($(id).open)$(id).close();
  $('removedNotice').textContent=message;screen('removed');
}
function loginView(admin=false){
  screen('welcome');$('nameForm').classList.toggle('hidden',admin);$('adminLoginForm').classList.toggle('hidden',!admin);
  $('adminLoginLink').classList.toggle('hidden',admin);$('regularLoginLink').classList.toggle('hidden',!admin);
  $('name').value=name;$('loginError').textContent='';
  if(admin)$('adminUsername').focus();
}
function adminEnded(message){
  if(loggingOut || accessRevoked)return;
  startVersion++;socket?.disconnect();setRole({role:'user'});
  $('memberConfirm').close();closeDelete();loginView(true);$('loginError').textContent=message;
}
async function api(url,options={}){
  const res=await fetch(url,{cache:'no-store',...options});
  if(!res.headers.get('Content-Type')?.includes('application/json')){
    throw Error('The server is not returning the current API. Stop the old server with Ctrl+C, restart InnerCircle from its project folder, then reload this page.');
  }
  let data;
  try{data=await res.json();}catch{throw Error('The server returned an invalid response. Restart InnerCircle and reload this page.');}
  if(!res.ok){
    if(data.banned)removed(data.error);
    else if(res.status===403 && url.startsWith('/api/admin/') && !url.endsWith('/login'))adminEnded('Your admin session is no longer valid. Please log in again.');
    throw Error(data.error || 'Request failed.');
  }
  return data;
}
function deletedLabel(m){return m.deletedByAdmin?'This message was deleted by admin.':'This message was deleted.';}
function openDelete(m,moderation=false){
  selected={id:m.id,moderation};$('deleteMe').hidden=moderation;
  $('deleteEveryone').hidden=m.deleted || !(m.canDeleteEveryone || m.mine || role==='admin');
  $('deleteDescription').textContent=role==='admin'?'Delete for Me hides the message on this browser. An admin deletion replaces it for everyone with “This message was deleted by admin.” and blocks its media link.':'Delete for Me hides this message on this browser. Delete for Everyone replaces it for everyone and blocks its media link.';
  $('deleteError').textContent='';$('deleteDialog').showModal();
}
function buildMessage(m,moderation=false){
  const bubble=document.createElement('article');bubble.id=(moderation?'moderation-':'msg-')+m.id;
  bubble.className='bubble'+(m.mine?' mine':'');
  const top=document.createElement('div');top.className='message-top';
  const sender=document.createElement('div');sender.className='sender';sender.textContent=m.sender;top.appendChild(sender);
  if(!moderation || !m.deleted){
    const menu=document.createElement('details');menu.className='message-menu';
    const toggle=document.createElement('summary');toggle.textContent='⋮';toggle.setAttribute('aria-label','Message options');
    const del=document.createElement('button');del.type='button';del.textContent='Delete';del.onclick=()=>{menu.open=false;openDelete(m,moderation);};
    menu.append(toggle,del);top.appendChild(menu);
  }
  bubble.appendChild(top);
  if(m.deleted || m.kind==='text'){const p=document.createElement('div');p.textContent=m.deleted?deletedLabel(m):m.body;if(m.deleted)p.className='deleted-message';bubble.appendChild(p);}
  else {const media=document.createElement(m.kind==='image'?'img':'video');media.src=m.body;if(m.kind==='video')media.controls=true;else media.alt='Shared photo';bubble.appendChild(media);}
  const time=document.createElement('time');time.dateTime=m.created_at;
  time.textContent=moderation?new Date(m.created_at).toLocaleString():new Date(m.created_at).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});bubble.appendChild(time);
  return bubble;
}
function addMessage(m){
  history.set(m.id,m);const previous=$('msg-'+m.id),bubble=buildMessage(m);
  if(previous){stopMedia(previous);previous.replaceWith(bubble);}else messages.appendChild(bubble);
  messages.scrollTop=messages.scrollHeight;
}
function addModerationMessage(m,prepend=false){
  moderationHistory.set(m.id,m);const previous=$('moderation-'+m.id),bubble=buildMessage(m,true);
  if(previous){stopMedia(previous);previous.replaceWith(bubble);}else if(prepend)$('moderationMessages').prepend(bubble);else $('moderationMessages').appendChild(bubble);
}
function updateModerationEvent(type,m){
  if(role!=='admin' || !moderationLoaded)return;
  if(type==='chat-message')addModerationMessage({...m,canDeleteEveryone:!m.deleted},true);
  if(type==='message-deleted' && moderationHistory.has(m.id))addModerationMessage({...moderationHistory.get(m.id),deleted:true,deletedByAdmin:!!m.byAdmin,kind:'text',body:deletedLabel({deletedByAdmin:m.byAdmin}),canDeleteEveryone:false});
}
function applyEvent(type,m){
  if(accessRevoked)return;
  if(type==='chat-message')addMessage(m);
  if(type==='message-hidden'){history.delete(m.id);const element=$('msg-'+m.id);stopMedia(element);element?.remove();}
  if(type==='message-deleted'){
    const update=previous=>({...previous,deleted:true,deletedByAdmin:!!m.byAdmin,kind:'text',body:deletedLabel({deletedByAdmin:m.byAdmin}),canDeleteEveryone:false});
    if(history.has(m.id))addMessage(update(history.get(m.id)));
  }
  if(moderationLoading)moderationPending.push([type,m]);else updateModerationEvent(type,m);
  if(selected?.id===m.id && type!=='chat-message')closeDelete();saveCache();
}
async function syncHistory(){
  if(syncing || accessRevoked)return;
  syncing=true;
  try {
    const rows=await api('/api/messages');if(accessRevoked)return;
    history.clear();stopMedia(messages);messages.replaceChildren();rows.forEach(addMessage);
  } catch(err){if(!accessRevoked)$('status').textContent='History unavailable — reconnect to retry';}
  finally {syncing=false;if(!accessRevoked){pending.splice(0).forEach(([type,m])=>applyEvent(type,m));saveCache();}else pending=[];}
}
async function start(){
  const version=++startVersion;socket?.disconnect();
  try {
    const state=await api('/api/session');if(version!==startVersion)return;
    if(state.banned){removed();return;}setRole(state);
    if(role==='admin')name=state.name;
  } catch {if(accessRevoked || version!==startVersion)return;setRole({role:'user'});}
  screen('chat');
  if(!history.size)try{JSON.parse(localStorage.getItem('innercircle-cache')||'[]').forEach(addMessage);}catch{}
  await syncHistory();if(accessRevoked || version!==startVersion)return;
  socket=io();const current=socket;
  current.on('connect',()=>{
    current.timeout(8000).emit('join',name,(err,result)=>{
      if(result?.banned){removed();return;}
      if(err || result?.error)$('status').textContent=result?.error || 'Unable to join — reload to retry';
    });
    $('status').textContent='Connected';syncHistory();
  });
  current.on('disconnect',()=>{if(!accessRevoked)$('status').textContent='Offline';});
  current.on('connect_error',err=>{if(err.data?.banned)removed();else $('status').textContent='Unable to connect — reload to retry';});
  current.on('online-count',n=>{$('status').textContent=`${n} member${n===1?'':'s'} online`;});
  current.on('members-updated',data=>{memberData=data;renderMembers(data,false);});
  current.on('admin-members-updated',data=>{if(role==='admin'){adminMemberData=data;renderMembers(data,true);}});
  current.on('member-removed',data=>removed(data.message));
  current.on('admin-session-ended',data=>adminEnded(data.message));
  for(const type of ['chat-message','message-hidden','message-deleted'])current.on(type,m=>{
    if(syncing)pending.push([type,m]);else applyEvent(type,m);
    if(type==='chat-message'&&!m.mine&&!accessRevoked&&document.hidden&&'Notification' in window&&Notification.permission==='granted')new Notification('InnerCircle: '+m.sender,{body:m.kind==='text'?m.body:'Sent a '+m.kind});
  });
}
function renderMembers(data,admin){
  const list=admin?$('adminMemberList'):$('memberList');list.replaceChildren();
  if(admin){$('totalMembers').textContent=data.total;$('onlineMembers').textContent=data.online;$('bannedMembers').textContent=data.banned;}
  else $('membersSummary').textContent=`${data.total} member${data.total===1?'':'s'} · ${data.online} online`;
  if(!data.members.length){const empty=document.createElement('p');empty.className='muted';empty.textContent='No members yet.';list.appendChild(empty);}
  for(const member of data.members){
    const row=document.createElement('div');row.className='member-row';row.dataset.memberId=member.id;
    const details=document.createElement('div');details.className='member-details';
    const label=document.createElement('strong');label.textContent=member.name;details.appendChild(label);
    if(member.role==='admin'){const badge=document.createElement('span');badge.className='role-badge';badge.textContent='Admin';details.appendChild(badge);}
    const status=document.createElement('small');status.textContent=(member.banned?'Removed':member.online?'Online':'Offline')+(admin?' · Device '+member.id.slice(0,8):'');details.appendChild(status);row.appendChild(details);
    if(admin && member.role!=='admin'){
      const button=document.createElement('button');button.type='button';button.textContent=member.banned?'Unban User':'Remove User';
      button.onclick=()=>confirmMember(member,member.banned?'unban':'remove');row.appendChild(button);
    }
    list.appendChild(row);
  }
}
function confirmMember(member,action){
  memberAction={id:member.id,action};$('memberConfirmTitle').textContent=action==='remove'?'Remove member?':'Unban member?';
  $('memberConfirmName').textContent=member.name+' · Device '+member.id.slice(0,8);
  $('memberConfirmText').textContent=action==='remove'?'Are you sure you want to remove this user from InnerCircle?':'Allow this user to rejoin InnerCircle?';
  $('confirmMemberAction').textContent=action==='remove'?'Remove User':'Unban User';$('memberActionError').textContent='';$('memberConfirm').showModal();
}
async function showDashboard(){
  if(role!=='admin'){socket?.disconnect();loginView(true);return;}
  screen('adminDashboard');$('adminIdentity').textContent=name;$('dashboardError').textContent='';
  try {adminMemberData=await api('/api/admin/members');if(role==='admin')renderMembers(adminMemberData,true);}catch(err){$('dashboardError').textContent=err.message;}
}
async function loadModeration(reset=false){
  if(role!=='admin' || moderationLoading)return;
  moderationLoading=true;
  const button=$('loadOlder');button.disabled=true;$('dashboardError').textContent='';
  try {
    const data=await api('/api/admin/messages'+(!reset && nextBefore?'?before='+nextBefore:''));if(role!=='admin')return;
    if(reset)clearModeration();data.messages.forEach(m=>addModerationMessage(m));moderationLoaded=true;nextBefore=data.nextBefore;button.classList.toggle('hidden',!nextBefore);
  } catch(err){$('dashboardError').textContent=err.message;}finally{button.disabled=false;moderationLoading=false;moderationPending.splice(0).forEach(([type,m])=>updateModerationEvent(type,m));}
}
async function deleteSelected(scope){
  if(!selected || !socket?.connected){$('deleteError').textContent='Connect to delete this message.';return;}
  const id=selected.id,buttons=[$('deleteMe'),$('deleteEveryone')];buttons.forEach(b=>b.disabled=true);
  socket.timeout(8000).emit('delete-message',{id,scope,...(role==='admin'?{csrf}:{})},(err,result)=>{
    buttons.forEach(b=>b.disabled=false);
    if(err || result?.error){$('deleteError').textContent=result?.error || 'Deletion could not be confirmed. Reconnect and retry.';return;}closeDelete();
  });
}
$('deleteMe').onclick=()=>deleteSelected('me');$('deleteEveryone').onclick=()=>deleteSelected('everyone');$('deleteCancel').onclick=closeDelete;
$('deleteDialog').addEventListener('cancel',()=>{selected=null;});
$('adminLoginLink').onclick=()=>loginView(true);
$('regularLoginLink').onclick=()=>loginView(false);
$('showAdmin').onclick=showDashboard;
$('viewChat').onclick=()=>screen('chat');
$('showMembers').onclick=async()=>{
  $('membersError').textContent='';if(memberData)renderMembers(memberData,false);$('membersDialog').showModal();
  try{memberData=await api('/api/members');renderMembers(memberData,false);}catch(err){$('membersError').textContent=err.message;}
};
$('closeMembers').onclick=()=>$('membersDialog').close();
$('membersTab').onclick=()=>{$('membersTab').setAttribute('aria-selected','true');$('moderationTab').setAttribute('aria-selected','false');$('adminMemberPanel').classList.remove('hidden');$('moderationPanel').classList.add('hidden');};
$('moderationTab').onclick=()=>{$('membersTab').setAttribute('aria-selected','false');$('moderationTab').setAttribute('aria-selected','true');$('adminMemberPanel').classList.add('hidden');$('moderationPanel').classList.remove('hidden');loadModeration(true);};
$('loadOlder').onclick=()=>loadModeration();
$('cancelMemberAction').onclick=()=>{$('memberConfirm').close();memberAction=null;};
$('memberConfirm').addEventListener('cancel',()=>{memberAction=null;});
$('confirmMemberAction').onclick=async()=>{
  if(!memberAction)return;const button=$('confirmMemberAction');button.disabled=true;
  try {
    await api('/api/admin/members/'+encodeURIComponent(memberAction.id)+'/'+memberAction.action,{method:'POST',headers:{'X-CSRF-Token':csrf}});
    $('memberConfirm').close();memberAction=null;
  }catch(err){$('memberActionError').textContent=err.message;}finally{button.disabled=false;}
};
$('adminLoginForm').addEventListener('submit',async e=>{
  e.preventDefault();const button=$('adminLoginSubmit');button.disabled=true;$('loginError').textContent='';
  try {
    const data=await api('/api/admin/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:$('adminUsername').value.trim(),password:$('adminPassword').value})});
    name=data.name;localStorage.setItem('innercircle-name',name);setRole(data);await start();if(role==='admin')await showDashboard();
  }catch(err){$('loginError').textContent=err.message;}finally{$('adminPassword').value='';button.disabled=false;}
});
$('adminLogout').onclick=async()=>{
  const button=$('adminLogout');button.disabled=true;loggingOut=true;
  try {
    await api('/api/admin/logout',{method:'POST',headers:{'X-CSRF-Token':csrf}});
    socket?.disconnect();setRole({role:'user'});loginView(false);
  }catch(err){$('dashboardError').textContent=err.message;}finally{button.disabled=false;loggingOut=false;}
};
$('nameForm').addEventListener('submit',e=>{e.preventDefault();name=$('name').value.trim();if(!name)return;localStorage.setItem('innercircle-name',name);start();});
$('composer').addEventListener('submit',e=>{e.preventDefault();const body=$('message').value.trim();if(body&&socket?.connected&&!accessRevoked){socket.emit('chat-message',{kind:'text',body});$('message').value='';}});
$('media').addEventListener('change',async e=>{
  const file=e.target.files[0];if(!file)return;
  if(file.size>20*1024*1024){alert('Maximum file size is 20 MB');e.target.value='';return;}
  const form=new FormData();form.append('media',file);
  try{if(!socket?.connected || accessRevoked)throw Error('Connect before uploading media.');const data=await api('/api/upload',{method:'POST',body:form});if(socket?.connected&&!accessRevoked)socket.emit('chat-message',{kind:data.kind,body:data.url});}
  catch(err){alert(err.message);}finally{e.target.value='';}
});
$('notify').addEventListener('click',async()=>{if('Notification' in window){const result=await Notification.requestPermission();alert(result==='granted'?'Notifications enabled while the app is running.':'Notifications not enabled.');}else alert('Notifications are not supported in this browser.');});
$('checkAccess').onclick=()=>location.reload();
(async()=>{
  try {
    const state=await api('/api/session');if(state.banned){removed();return;}setRole(state);
    if(role==='admin')name=state.name;
  }catch{}
  if(name)start();else loginView(false);
})();
