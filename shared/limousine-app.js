(() => {
  const role = document.body.dataset.role;
  const $ = (id) => document.getElementById(id);
  const user = (() => { try { return JSON.parse(localStorage.getItem(role === 'passenger' ? 'tarhal_customer' : 'tarhal_driver') || 'null'); } catch { return null; } })();
  const token = localStorage.getItem('session_token') || '';
  let config = { cities: [], categories: [], pricing: [] };
  let requests = [], contracts = [], acceptances = [], drivers = [];
  const money = n => Number(n || 0).toLocaleString('ar-SD') + ' ج.س';
  const date = d => d ? new Date(d).toLocaleString('ar-SD', { dateStyle: 'medium', timeStyle: 'short' }) : '—';
  const statusNames = { open:'بانتظار قبول السائقين', awaiting_driver_selection:'بانتظار اختيار سائق', driver_selected:'تم اختيار السائق', confirmed:'مؤكد', awaiting_funding:'بانتظار تأمين العمولة', booked:'محجوز مالياً', active:'نشط', completion_requested:'طلب إنهاء الخدمة', awaiting_settlement:'بانتظار التسوية', settled:'تمت التسوية', disputed:'متنازع عليه', cancelled:'ملغى' };
  async function api(action, payload = {}) {
    const res = await fetch('/api/limousine', { method:'POST', headers:{'Content-Type':'application/json','Authorization':token ? 'Bearer '+token : ''}, body:JSON.stringify({action,...payload}) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.success) throw new Error(data.error || 'تعذر إكمال العملية');
    return data;
  }
  function notice(message, bad=false) {
    const el=$('notice'); el.textContent=message; el.className='notice show'+(bad?' error':'');
    setTimeout(()=>el.classList.remove('show'),4500);
  }
  function requireLogin() {
    if (!user?.id || !token) { $('app').innerHTML='<div class="empty">يرجى تسجيل الدخول إلى تطبيق تراكا أولاً، ثم فتح منصة ليموزين تراكا.</div>'; return false; }
    return true;
  }
  function pricingFor(city, category) { return config.pricing.find(x=>x.city_id===city && x.vehicle_category_id===category); }
  async function loadConfig() {
    const data=await api('list_config'); config=data;
    $('city').innerHTML='<option value="">اختر المدينة</option>'+config.cities.map(x=>'<option value="'+x.id+'">'+esc(x.name_ar)+'</option>').join('');
    $('category').innerHTML='<option value="">اختر فئة السيارة</option>'+config.categories.map(x=>'<option value="'+x.id+'">'+esc(x.name_ar)+'</option>').join('');
    updateEstimate();
  }
  function updateEstimate() {
    if (role!=='passenger') return;
    const p=pricingFor($('city').value,$('category').value), days=Math.max(1,Number($('days').value)||1);
    $('estimate').textContent=p ? 'السعر اليومي: '+money(p.daily_price)+' — الإجمالي التقديري: '+money(p.daily_price*days)+' — عمولة السائق: '+p.commission_rate+'%' : 'اختر المدينة وفئة السيارة لعرض السعر المتاح.';
  }
  function esc(s) { return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  async function passengerRequests() {
    const data=await api('list_passenger_requests',{passengerId:user.id});
    requests=data.requests||[]; acceptances=data.acceptances||[]; drivers=data.drivers||[]; contracts=data.contracts||[];
    const list=$('requests');
    if (!requests.length) { list.innerHTML='<div class="empty">لا توجد طلبات تأجير حتى الآن.</div>'; return; }
    list.innerHTML=requests.map(r=>{
      const acc=acceptances.filter(a=>a.request_id===r.id && ['accepted','selected','contracted'].includes(a.status));
      const contract=contracts.find(c=>c.request_id===r.id);
      const ds=drivers.filter(d=>acc.some(a=>a.driver_id===d.id));
      return '<article class="card"><div class="line"><strong>طلب تأجير</strong><span class="pill">'+esc(statusNames[r.status]||r.status)+'</span></div>'+
        '<p>'+esc(r.pickup_area)+' — '+date(r.start_at)+'</p><p>'+r.duration_days+' يوم · '+money(r.estimated_total)+'</p>'+
        (acc.length?'<div class="driver-list"><b>السائقون الذين قبلوا ('+acc.length+')</b>'+ds.map(d=>{const a=acc.find(x=>x.driver_id===d.id);return '<div class="driver-row"><span>'+esc(d.full_name)+' · '+esc(d.car_model||d.car_type||'')+' · ★ '+esc(d.rating??'—')+'</span>'+(r.status==='open'||r.status==='awaiting_driver_selection'?'<button class="small" data-select="'+r.id+'" data-driver="'+d.id+'">اختيار</button>':a.status==='selected'?'<span class="pill">مختار</span>':'')+'</div>';}).join('')+'</div>':'<p class="muted">بانتظار قبول السائقين.</p>')+
        (contract?'<p class="muted">العقد: '+esc(statusNames[contract.status]||contract.status)+'</p>':'')+'</article>';
    }).join('');
    list.querySelectorAll('[data-select]').forEach(btn=>btn.onclick=async()=>{try{btn.disabled=true;await api('select_driver',{passengerId:user.id,requestId:btn.dataset.select,driverId:btn.dataset.driver});notice('تم تسجيل اختيار السائق.');await refresh();}catch(e){notice(e.message,true);btn.disabled=false;}});
  }
  async function driverRequests() {
    const data=await api('list_driver_requests',{driverId:user.id});
    requests=data.requests||[];
    $('requests').innerHTML=requests.length?requests.map(r=>'<article class="card"><div class="line"><strong>طلب تأجير جديد</strong><span class="pill">'+esc(r.accepted_count)+' / 10 قبول</span></div><p>'+esc(r.pickup_area)+' · '+date(r.start_at)+'</p><p>'+r.duration_days+' يوم · '+money(r.estimated_total)+'</p><p>عدد الركاب: '+r.passenger_count+' · '+esc(r.usage_purpose||'')+'</p><p class="muted">'+esc(r.notes||'')+'</p><button class="primary" data-accept="'+r.id+'">قبول مبدئي</button></article>').join(''):'<div class="empty">لا توجد طلبات تأجير مناسبة لسيارتك حالياً.</div>';
    $('requests').querySelectorAll('[data-accept]').forEach(btn=>btn.onclick=async()=>{try{btn.disabled=true;await api('accept_request',{driverId:user.id,requestId:btn.dataset.accept});notice('تم قبول الطلب مبدئياً.');await refresh();}catch(e){notice(e.message,true);btn.disabled=false;}});
  }
  async function loadContracts() {
    const d=await api('list_contracts',{driverId:user.id,passengerId:user.id}); contracts=d.contracts||[];
    $('contracts').innerHTML=contracts.length?contracts.map(c=>'<article class="card"><div class="line"><strong>عقد تأجير</strong><span class="pill">'+esc(statusNames[c.status]||c.status)+'</span></div><p>'+date(c.start_at)+' — '+date(c.scheduled_end_at)+'</p><p>'+c.duration_days+' يوم · '+money(c.contract_value_snapshot)+'</p>'+
      (['booked','active'].includes(c.status)?'<button class="secondary" data-end="'+c.id+'">طلب إنهاء الخدمة</button>':'')+
      (c.status==='completion_requested' && c.end_requested_by!==role?'<button class="secondary" data-confirm-end="'+c.id+'">تأكيد انتهاء الخدمة</button>':c.status==='completion_requested'?'<p class="muted">طلب الإنهاء بانتظار تأكيد الطرف الآخر.</p>':'')+
      (c.status==='awaiting_settlement'?'<p class="muted">تم تأكيد انتهاء الخدمة، والعقد بانتظار مراجعة الإدارة والتسوية.</p>':'')+
      '<button class="small" data-chat="'+c.id+'">فتح المحادثة</button><div class="chat" id="chat-'+c.id+'" hidden><div class="messages" id="messages-'+c.id+'"></div><div class="line"><input id="msg-'+c.id+'" placeholder="اكتب رسالتك"><button class="small" data-send="'+c.id+'">إرسال</button></div></div></article>').join(''):'<div class="empty">لا توجد عقود حتى الآن.</div>';
    $('contracts').querySelectorAll('[data-end]').forEach(btn=>btn.onclick=async()=>{if(!confirm('هل تؤكد طلب إنهاء خدمة التأجير؟'))return;try{await api('request_end',{contractId:btn.dataset.end});notice('أُرسل طلب الإنهاء للطرف الآخر للتأكيد.');await refresh();}catch(e){notice(e.message,true);}});
    $('contracts').querySelectorAll('[data-confirm-end]').forEach(btn=>btn.onclick=async()=>{if(!confirm('هل تؤكد أن خدمة التأجير قد انتهت فعلاً؟'))return;try{await api('confirm_end',{contractId:btn.dataset.confirmEnd});notice('تم تأكيد انتهاء الخدمة، والعقد بانتظار التسوية الإدارية.');await refresh();}catch(e){notice(e.message,true);}});
    $('contracts').querySelectorAll('[data-chat]').forEach(btn=>btn.onclick=async()=>{const c=btn.dataset.chat,box=$('chat-'+c);box.hidden=!box.hidden;if(!box.hidden)await loadMessages(c);});
    $('contracts').querySelectorAll('[data-send]').forEach(btn=>btn.onclick=async()=>{const c=btn.dataset.send,field=$('msg-'+c);try{await api('send_message',{contractId:c,message:field.value});field.value='';await loadMessages(c);}catch(e){notice(e.message,true);}});
  }
  async function loadMessages(contractId) {
    const d=await api('list_messages',{contractId});
    $('messages-'+contractId).innerHTML=(d.messages||[]).map(m=>'<div class="message '+(m.sender_type===role?'mine':'')+'">'+esc(m.message)+'<small>'+date(m.created_at)+'</small></div>').join('');
  }
  async function refresh() {
    if(role==='passenger') await passengerRequests(); else await driverRequests();
    await loadContracts();
  }
  $('refresh').onclick=()=>refresh().catch(e=>notice(e.message,true));
  if(role==='passenger') {
    $('request-form').onsubmit=async e=>{e.preventDefault();try{
      const cityId=$('city').value,categoryId=$('category').value,price=pricingFor(cityId,categoryId);
      if(!price) throw new Error('لا يوجد سعر محدد لهذه المدينة وفئة السيارة.');
      const start=new Date($('start').value);
      if(!Number.isFinite(start.getTime())||start<=new Date()) throw new Error('حدد موعد بداية في المستقبل.');
      const days=Number($('days').value);
      if(days<price.min_days||(price.max_days&&days>price.max_days)) throw new Error('مدة التأجير خارج المدة المتاحة لهذه الفئة.');
      await api('create_request',{passengerId:user.id,cityId,pickupArea:$('pickup').value,startAt:start.toISOString(),durationDays:days,categoryId,passengerCount:Number($('passengers').value),purpose:$('purpose').value,notes:$('notes').value});
      $('request-form').reset();updateEstimate();notice('تم نشر طلب التأجير للسائقين المؤهلين.');await refresh();
    }catch(e){notice(e.message,true);}};
    ['city','category','days'].forEach(id=>$(id).addEventListener('change',updateEstimate));
  }
  if(requireLogin()) {
    loadConfig().then(refresh).catch(e=>notice(e.message,true));
    setInterval(()=>refresh().catch(()=>{}),30000);
  }
})();