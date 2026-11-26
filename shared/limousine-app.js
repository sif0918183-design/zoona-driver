(() => {
  'use strict';
  const role = document.body.dataset.role;
  const $ = id => document.getElementById(id);
  const user = (() => { try { return JSON.parse(localStorage.getItem(role === 'passenger' ? 'tarhal_customer' : 'tarhal_driver') || 'null'); } catch { return null; } })();
  const token = localStorage.getItem('session_token') || '';
  let config = { cities: [], categories: [], pricing: [] };
  let requests = [], acceptances = [], drivers = [], contracts = [], acceptedRequests = [];
  let activeSection = role === 'passenger' ? 'request' : 'available';
  let sectionLoaded = {};
  let fundingDeadline = null;
  let fundingContractId = null;
  let fundingExpiryProcessing = false;
  let fundingRefreshTimer = null;
  let fundingClockTimer = null;
  let fundingAttemptedAt = null;
  let fundingRetryProcessing = false;
  const fundingRetrySlots = new Set();
  const money = n => Math.round(Number(n || 0)).toLocaleString('en-US') + ' ج.س';
  const date = d => d ? new Date(d).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }) : '—';
  const statusNames = {
    open:'بانتظار قبول السائقين', awaiting_driver_selection:'بانتظار اختيار سائق',
    driver_selected:'تم اختيار السائق', confirmed:'مؤكد', awaiting_funding:role==='passenger'?'جارٍ استكمال التعاقد':'بانتظار تأمين العمولة',
    booked:'ساري', active:'ساري', completion_requested:'طلب إنهاء الخدمة',
    awaiting_settlement:'بانتظار التسوية', settled:'تمت التسوية', disputed:'نزاع',
    cancelled:'ملغي', expired:'فات وقته', accepted:'قبول مبدئي', selected:'تم الاختيار', contracted:'تم التعاقد'
  };
  const errorNames = {
    'غير مصرح':'انتهت صلاحية الجلسة أو لا تملك صلاحية تنفيذ هذه العملية. يرجى تسجيل الدخول مجدداً.',
    'start_must_be_future':'موعد بداية التأجير يجب أن يكون في المستقبل.',
    'outside_service_hours':'الموعد خارج ساعات الخدمة المتاحة.',
    'invalid_duration':'مدة التأجير غير صالحة.',
    'invalid_request_details':'يرجى مراجعة بيانات طلب التأجير.',
    'pricing_unavailable':'لا تتوفر خدمة التأجير لهذه المدينة وفئة السيارة حالياً.',
    'duration_out_of_pricing_range':'مدة التأجير خارج المدة المتاحة لهذه الفئة.',
    'request_not_available':'هذا الطلب لم يعد متاحاً للقبول.',
    'driver_not_eligible':'سيارتك غير مؤهلة لهذا الطلب.',
    'vehicle_category_not_eligible':'فئة السيارة لا تطابق الفئة المطلوبة.',
    'acceptance_limit_reached':'اكتمل عدد السائقين الذين يمكنهم قبول الطلب.',
    'driver_has_overlapping_limo_contract':'لديك عقد تأجير متداخل مع هذا الموعد.',
    'request_not_selectable':'لا يمكن اختيار هذا السائق لهذا الطلب.',
    'driver_has_not_accepted':'هذا السائق لم يقبل الطلب.',
    'insufficient_balance':role==='passenger'?'تعذر إتمام اختيار هذا السائق حالياً. يرجى اختيار سائق آخر.':'رصيد السائق غير كافٍ لتأمين العمولة.',
    'بيانات التواصل محجوبة حتى نجاح تأمين العمولة.':'ستظهر بيانات التواصل بعد اكتمال إجراءات التعاقد.',
    'تم تأمين العمولة؛ يجب تقديم طلب إلغاء بموافقة الطرفين ثم اعتماد الإدارة.':'يجب تقديم طلب إلغاء بموافقة الطرفين ثم اعتماد الإدارة.',
    'لم يتم تأمين العمولة بعد.':'لم يكتمل اعتماد العقد بعد.'
  };
  async function api(action, payload = {}) {
    const res = await fetch('/api/travel-platform?module=limousine', {
      method:'POST',
      headers:{'Content-Type':'application/json','Authorization':token ? 'Bearer '+token : ''},
      body:JSON.stringify({action,...payload})
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.success) {
      const raw = String(data.error || '');
      const technical = /^[a-z][a-z0-9_]*$/i.test(raw) || /^(Method not allowed|Unknown action|Action is required)$/i.test(raw);
      throw new Error(errorNames[raw] || (res.status >= 500 || technical ? 'تعذر تنفيذ الطلب حالياً. يرجى المحاولة مرة أخرى، وإذا تكرر الخطأ فتواصل مع الدعم.' : raw || 'تعذر إكمال العملية.'));
    }
    return data;
  }
  function notice(message, bad=false) {
    const el=$('notice');
    if (!el) return;
    el.textContent=message;
    el.className='notice show'+(bad?' error':'');
    clearTimeout(el._hideTimer);
    el._hideTimer=setTimeout(()=>el.classList.remove('show'),5000);
  }
  function esc(s) {
    return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }
  function requireLogin() {
    if (!user?.id || !token) {
      $('app').innerHTML='<div class="empty">يرجى تسجيل الدخول إلى تطبيق تراكا أولاً، ثم فتح منصة ليموزين تراكا.</div>';
      return false;
    }
    return true;
  }
  function setProfile(name, balance) {
    $('user-name').textContent=name || (role==='driver'?'السائق':'الراكب');
    $('user-avatar').textContent=(name || (role==='driver'?'س':'ر')).trim().charAt(0) || '؟';
    if (role==='driver') $('current-balance').textContent=money(balance);
  }
  function pricingFor(city, category) {
    return config.pricing.find(x=>x.city_id===city && x.vehicle_category_id===category);
  }
  async function loadConfig() {
    const data=await api('list_config');
    config=data;
    $('city').innerHTML='<option value="">اختر المدينة</option>'+config.cities.map(x=>'<option value="'+esc(x.id)+'">'+esc(x.name_ar)+'</option>').join('');
    $('category').innerHTML='<option value="">اختر فئة السيارة</option>'+config.categories.map(x=>'<option value="'+esc(x.id)+'">'+esc(x.name_ar)+'</option>').join('');
    updateEstimate();
  }
  function updateEstimate() {
    if (role!=='passenger') return;
    const p=pricingFor($('city').value,$('category').value), days=Math.max(1,Math.floor(Number($('days').value)||1));
    $('days').min='1'; $('days').max=String(p?.max_days||90);
    if(Number($('days').value)!==days)$('days').value=String(days);
    const timing='التأجير بالأيام الكاملة فقط — يبدأ اليوم الساعة 7:00 صباحاً وينتهي الساعة 5:00 مساءً.';
    $('estimate').textContent=p
      ? 'أجرة اليوم الواحد: '+money(p.daily_price)+' · المدة: '+days+' '+(days===1?'يوم':'أيام')+' · الإجمالي التقديري: '+money(Number(p.daily_price)*days)+'. '+timing
      : 'اختر المدينة وفئة السيارة المتاحتين لعرض أجرة اليوم والإجمالي. '+timing;
  }
  function carDescription(d) {
    return [d.car_model || d.car_type || 'سيارة', d.car_color || ''].filter(Boolean).join(' · ');
  }
  function passengerRentalDetails(r) {
    return '<div class="limo-rental-details">'+
      '<p><b>فئة السيارة:</b> '+esc(r.category_name||'—')+'</p>'+
      '<p><b>المدينة:</b> '+esc(r.city_name||'—')+'</p>'+
      '<p><b>موقع الاستلام:</b> '+esc(r.pickup_area||'—')+'</p>'+
      '<p><b>تاريخ البداية:</b> '+date(r.start_at)+'</p>'+
      '<p><b>عدد الأيام:</b> '+Number(r.duration_days||0)+' يوم</p>'+
      '<p><b>سعر اليوم:</b> '+money(r.daily_price_snapshot)+'</p>'+
      '<p><b>الإجمالي:</b> '+money(r.estimated_total)+'</p>'+
      '<p>عدد الركاب: '+Number(r.passenger_count||1)+' · '+esc(r.usage_purpose||'')+'</p>'+
      '<p class="muted">'+esc(r.notes||'')+'</p></div>';
  }
  async function passengerRequests() {
    const data=await api('list_passenger_requests',{passengerId:user.id});
    requests=data.requests||[];
    acceptances=data.acceptances||[];
    drivers=data.drivers||[];
    contracts=data.contracts||[];
    const list=$('requests');
    if (!requests.length) {
      list.innerHTML='<div class="empty">لا توجد طلبات تأجير حتى الآن.</div>';
      return;
    }
    list.innerHTML=requests.map(r=>{
      const acc=acceptances.filter(a=>a.request_id===r.id && ['accepted','selected','contracted'].includes(a.status));
      const contract=contracts.find(c=>c.request_id===r.id);
      const canCancelRequest=['open','awaiting_driver_selection','driver_selected'].includes(r.status);
      const ds=drivers.filter(d=>d.request_id===r.id && acc.some(a=>a.driver_id===d.id));
      const driverCards=ds.map(d=>{
        const a=acc.find(x=>x.driver_id===d.id);
        const label=d.identity_released ? esc(d.full_name || 'سائق تراكا') : 'سائق تراكا';
        const detail=esc(carDescription(d));
        const canSelect=['open','awaiting_driver_selection'].includes(r.status) && a?.status==='accepted';
        return '<div class="driver-row"><div><strong>'+label+'</strong><div class="muted">'+detail+'</div></div>'+
          (canSelect?'<button class="small" data-select="'+esc(r.id)+'" data-driver="'+esc(d.id)+'">اختيار</button>':a?.status==='selected'?'<span class="pill">تم الاختيار</span>':'')+'</div>';
      }).join('');
      return '<article class="card"><div class="line"><strong>طلب تأجير</strong><span class="pill">'+esc(statusNames[r.status]||r.status)+'</span></div>'+
        passengerRentalDetails(r)+
        (acc.length?'<div class="driver-list"><b>السائقون الذين قبلوا ('+acc.length+')</b>'+driverCards+'</div>':r.status==='awaiting_driver_selection'?'<p class="muted">بانتظار قبول سائقين آخرين حتى تتمكن من اختيار سائق بديل.</p>':'<p class="muted">بانتظار قبول السائقين.</p>')+
        (contract?'<p class="muted">العقد: '+esc(statusNames[contract.status]||contract.status)+'</p>':'')+
        (canCancelRequest?'<button class="secondary" data-cancel-request="'+esc(r.id)+'">إلغاء الطلب</button>':'')+'</article>';
    }).join('');
    list.querySelectorAll('[data-select]').forEach(btn=>btn.onclick=async()=>{
      try {
        btn.disabled=true;
        await api('select_driver',{passengerId:user.id,requestId:btn.dataset.select,driverId:btn.dataset.driver});
        notice('تم تسجيل اختيار السائق. ستظهر حالة العقد بعد اكتمال إجراءات التعاقد.');
        await passengerRequests();
      } catch(e) { notice(e.message,true); btn.disabled=false; }
    });
    list.querySelectorAll('[data-cancel-request]').forEach(btn=>btn.onclick=async()=>{
      if(!confirm('هل تريد إلغاء طلب التأجير قبل اكتمال التعاقد؟'))return;
      try{btn.disabled=true;await api('cancel_request',{passengerId:user.id,requestId:btn.dataset.cancelRequest});
        notice('تم إلغاء طلب التأجير.');await passengerRequests();}
      catch(e){notice(e.message,true);btn.disabled=false;}
    });
  }
  function rentalDetails(r) {
    const start=r.start_at ? new Date(r.start_at) : null;
    const due=r.funding_required_by || (start ? new Date(start.getTime()-20*60*60*1000).toISOString() : null);
    const commission=Number(r.commission_due ?? (Number(r.estimated_total||0)*Number(r.commission_rate||0)/100));
    return '<div class="limo-rental-details">'+
      '<p><b>فئة السيارة:</b> '+esc(r.category_name||'—')+'</p>'+
      '<p><b>المدينة:</b> '+esc(r.city_name||'—')+'</p>'+
      '<p><b>موقع الاستلام:</b> '+esc(r.pickup_area||'—')+'</p>'+
      '<p><b>تاريخ البداية:</b> '+date(r.start_at)+'</p>'+
      '<p><b>عدد الأيام:</b> '+Number(r.duration_days||0)+' يوم</p>'+
      '<p><b>سعر اليوم:</b> '+money(r.daily_price_snapshot)+'</p>'+
      '<p><b>الإجمالي:</b> '+money(r.estimated_total)+'</p>'+
      '<p><b>نسبة العمولة:</b> '+Number(r.commission_rate||0)+'%</p>'+
      '<p><b>العمولة:</b> '+money(commission)+'</p>'+
      (r.acceptance_status==='funding_expired'?'<p class="limo-funding-reminder">انتهت مهلة تأمين العمولة لهذا الطلب.</p>':r.acceptance_status==='withdrawn'||r.status==='expired'?'':'<p class="limo-funding-reminder">يجب توفر مبلغ '+money(commission)+' على الأقل في رصيدك بحلول الساعة '+date(due)+'.</p>')+'</div>';
  }
  function renderDriverRequests() {
    $('requests').innerHTML=requests.length?requests.map(r=>
      '<article class="card"><div class="line"><strong>طلب تأجير جديد</strong><span class="pill">'+esc(r.accepted_count)+' / 10 قبول</span></div>'+
      rentalDetails(r)+
      '<p>عدد الركاب: '+r.passenger_count+' · '+esc(r.usage_purpose||'')+'</p><p class="muted">'+esc(r.notes||'')+'</p>'+
      '<button class="primary" data-accept="'+esc(r.id)+'">قبول مبدئي</button></article>').join(''):'<div class="empty">لا توجد طلبات تأجير مناسبة لسيارتك حالياً.</div>';
    $('requests').querySelectorAll('[data-accept]').forEach(btn=>btn.onclick=async()=>{
      try {
        btn.disabled=true;
        await api('accept_request',{driverId:user.id,requestId:btn.dataset.accept});
        notice('تم قبول الطلب مبدئياً. ينتظر الآن اختيار الراكب، ولا تُحجز العمولة في هذه المرحلة.');
        await driverRequests();
      } catch(e) { notice(e.message,true); btn.disabled=false; }
    });
  }
  function renderAcceptedRequests() {
    $('accepted-requests').innerHTML=acceptedRequests.length?acceptedRequests.map(r=>{
      const expired=r.status==='expired';
      const fundingExpired=r.acceptance_status==='funding_expired';
      const withdrawn=r.acceptance_status==='withdrawn';
      const canWithdraw=!expired&&!fundingExpired&&!withdrawn&&['accepted','selected'].includes(r.acceptance_status)&&['open','awaiting_driver_selection','driver_selected'].includes(r.status);
      const label=expired?'فات وقته':fundingExpired?'انتهت مهلة تأمين العمولة':withdrawn?'سحبت قبولك':r.acceptance_status==='accepted'?'بانتظار اختيار الراكب':r.acceptance_status==='selected'?'تم اختيارك — بانتظار تأمين العمولة':'تم التعاقد';
      const detail=expired?'انتهى موعد بداية التأجير دون اختيار سائق وتأمين العمولة، وأُغلق الطلب تلقائياً.':fundingExpired?'لم يتم تأمين العمولة خلال المهلة، ويمكن للراكب اختيار سائق بديل.':withdrawn?'سحبت قبولك لهذا الطلب.':r.acceptance_status==='accepted'?'ينتظر الطلب اختيار الراكب. لا يتم حجز العمولة عند القبول المبدئي.':r.acceptance_status==='selected'?'تم اختيارك لهذا الطلب. تبدأ إجراءات تأمين العمولة وفق موعد الحجز.':'راجع قسم العقود لمتابعة الحجز.';
      const stateClass=fundingExpired||expired?' limo-funding-expired':withdrawn?' limo-request-withdrawn':'';
      return '<article class="card"><div class="line"><strong>طلب قبلته</strong><span class="pill'+stateClass+'">'+label+'</span></div>'+
        rentalDetails(r)+
        '<p class="muted">'+detail+'</p>'+
        (canWithdraw?'<button class="secondary" data-withdraw="'+esc(r.id)+'">سحب القبول</button>':'')+'</article>';
    }).join(''):'<div class="empty">لا توجد طلبات قبلتها وتنتظر اختيار الراكب.</div>';
  }
  async function driverRequests() {
    const data=await api('list_driver_requests',{driverId:user.id});
    requests=data.requests||[];
    acceptedRequests=data.accepted_requests||[];
    if (data.profile) setProfile(data.profile.full_name, data.profile.balance);
    renderDriverRequests();
    renderAcceptedRequests();
    $('accepted-requests').querySelectorAll('[data-withdraw]').forEach(btn=>btn.onclick=async()=>{
      if(!confirm('هل تريد سحب قبولك لهذا الطلب؟ لن تُخصم أو تُحجز عمولة.'))return;
      try{btn.disabled=true;await api('withdraw_acceptance',{driverId:user.id,requestId:btn.dataset.withdraw});
        notice('تم سحب قبولك دون أي خصم أو حجز عمولة.');await driverRequests();}
      catch(e){notice(e.message,true);btn.disabled=false;}
    });
  }
  async function loadContracts() {
    const d=await api('list_contracts',{driverId:user.id,passengerId:user.id});
    contracts=d.contracts||[];
    $('contracts').innerHTML=contracts.length?contracts.map(c=>{
      const canView=role==='passenger'?c.contract_available===true:Number(c.commission_held||0)>0 && ['booked','active','completion_requested','awaiting_settlement','settled','disputed'].includes(c.status);
      const cx=c.cancellation_request;
      const canRequestCancellation=['booked','active'].includes(c.status)&&(!cx||['rejected'].includes(cx.status));
      const cancellationMarkup=cx?.status==='pending_counterparty'
        ?(cx.requested_by_role===role?'<p class="muted">طلب الإلغاء الذي قدمته بانتظار موافقة الطرف الآخر.</p>':'<p class="muted">طلب الطرف الآخر إلغاء العقد: '+esc(cx.reason)+'</p><button class="secondary" data-cancel-approve="'+esc(c.id)+'">الموافقة على الإلغاء</button><button class="small" data-cancel-reject="'+esc(c.id)+'">رفض الطلب</button>')
        :cx?.status==='awaiting_admin'?'<p class="muted">وافق الطرفان على الإلغاء. الطلب الآن بانتظار اعتماد إدارة تراكا.</p>'
        :cx?.status==='rejected'?'<p class="muted">رُفض طلب الإلغاء السابق. يظل العقد قائماً.</p>'
        :cx?.status==='approved'?'<p class="muted">اعتمدت الإدارة إلغاء العقد والتسوية.</p>':'';
      return '<article class="card"><div class="line"><strong>عقد تأجير</strong><span class="pill">'+esc(statusNames[c.status]||c.status)+'</span></div>'+
      '<p><b>المدينة:</b> '+esc(c.city_name||'—')+'</p><p><b>موقع الاستلام:</b> '+esc(c.pickup_area||'—')+'</p><p><b>بداية العقد:</b> '+date(c.start_at)+'</p>'+
      '<p><b>رقم العقد:</b> '+esc(c.contract_number||String(c.id).slice(0,8))+'</p><p><b>المدة:</b> '+Number(c.duration_days||0)+' يوم</p><p><b>نهاية العقد:</b> '+date(c.scheduled_end_at)+'</p>'+
      (canView?'<button class="primary" data-contract-document="'+esc(c.id)+'">عرض العقد الكامل</button>':'<p class="muted">'+(role==='passenger'?'سيظهر العقد بعد اكتمال إجراءات التعاقد.':'سيظهر العقد الكامل بعد تأمين العمولة وبدء العقد.')+'</p>')+
      (['booked','active','completion_requested','awaiting_settlement','settled','disputed'].includes(c.status)?'<button class="small" data-contact="'+esc(c.id)+'">عرض بيانات التواصل</button><div id="contact-'+esc(c.id)+'" class="muted" hidden></div>':'')+
      (c.status==='active'?'<button class="secondary" data-end="'+esc(c.id)+'">طلب إنهاء الخدمة</button>':'')+
      (['active','completion_requested','awaiting_settlement'].includes(c.status)?'<button class="small" data-dispute="'+esc(c.id)+'">رفع نزاع للإدارة</button>':'')+
      (c.status==='completion_requested' && c.end_requested_by!==role?'<button class="secondary" data-confirm-end="'+esc(c.id)+'">نعم، انتهت الخدمة</button><button class="small" data-reject-end="'+esc(c.id)+'">لا، لم تنتهِ الخدمة</button>':c.status==='completion_requested'?'<p class="muted">طلب الإنهاء بانتظار تأكيد الطرف الآخر.</p>':'')+
      (c.status==='awaiting_settlement'?'<p class="muted">تم تأكيد انتهاء الخدمة، والعقد بانتظار مراجعة الإدارة والتسوية.</p>':'')+
      cancellationMarkup+
      (canRequestCancellation?'<button class="secondary" data-request-cancel="'+esc(c.id)+'">طلب إلغاء العقد</button>':'')+'</article>';
    }).join(''):'<div class="empty">لا توجد عقود حتى الآن.</div>';
    $('contracts').querySelectorAll('[data-contract-document]').forEach(btn=>btn.onclick=()=>showContractDocument(btn.dataset.contractDocument));
    $('contracts').querySelectorAll('[data-contact]').forEach(btn=>btn.onclick=async()=>{
      const c=btn.dataset.contact,box=$('contact-'+c);if(!box.hidden){box.hidden=true;return;}
      try{const d=await api('get_contract_contact',{contractId:c}),x=d.contact||{};
        const phones=role==='passenger'?[['الهاتف',x.phone],['واتساب',x.whatsapp_number]]:[['الهاتف',x.phone],['رقم إضافي',x.phone2]];
        box.innerHTML='<p><b>'+esc(x.full_name||'')+'</b></p>'+phones.filter(v=>v[1]).map(v=>'<p><b>'+v[0]+':</b> '+esc(v[1])+'</p>').join('')+
          (role==='passenger'?'<p>'+esc([x.car_model,x.car_type,x.car_color,x.car_plate_number].filter(Boolean).join(' · '))+'</p>':'');
        box.hidden=false;
      }
      catch(e){notice(e.message,true);}
    });
    $('contracts').querySelectorAll('[data-end]').forEach(btn=>btn.onclick=async()=>{if(!confirm('هل تؤكد طلب إنهاء خدمة التأجير؟'))return;try{await api('request_end',{contractId:btn.dataset.end});notice('أُرسل طلب الإنهاء للطرف الآخر للتأكيد.');await loadContracts();}catch(e){notice(e.message,true);}});
    $('contracts').querySelectorAll('[data-confirm-end]').forEach(btn=>btn.onclick=async()=>{if(!confirm('هل تؤكد أن خدمة التأجير قد انتهت فعلاً؟'))return;try{await api('confirm_end',{contractId:btn.dataset.confirmEnd});notice('تم تأكيد انتهاء الخدمة، والعقد بانتظار التسوية الإدارية.');await loadContracts();}catch(e){notice(e.message,true);}});
    $('contracts').querySelectorAll('[data-reject-end]').forEach(btn=>btn.onclick=async()=>{if(!confirm('هل تؤكد أن خدمة التأجير لم تنتهِ بعد وأن العقد سيظل نشطاً؟'))return;try{await api('reject_end',{contractId:btn.dataset.rejectEnd});notice('تم رفض طلب الإنهاء، وسيظل العقد نشطاً.');await loadContracts();}catch(e){notice(e.message,true);}});
    $('contracts').querySelectorAll('[data-dispute]').forEach(btn=>btn.onclick=async()=>{const reason=prompt('اكتب سبب النزاع باختصار:');if(reason===null)return;try{await api('raise_dispute',{contractId:btn.dataset.dispute,reason});notice('تم رفع النزاع للإدارة.');await loadContracts();}catch(e){notice(e.message,true);}});
    $('contracts').querySelectorAll('[data-request-cancel]').forEach(btn=>btn.onclick=async()=>{
      const reason=prompt('اكتب سبب طلب إلغاء العقد (مطلوب):');if(reason===null)return;
      try{btn.disabled=true;await api('request_cancellation',{contractId:btn.dataset.requestCancel,reason});
        notice('أُرسل طلب الإلغاء للطرف الآخر للموافقة.');await loadContracts();}
      catch(e){notice(e.message,true);btn.disabled=false;}
    });
    $('contracts').querySelectorAll('[data-cancel-approve],[data-cancel-reject]').forEach(btn=>btn.onclick=async()=>{
      const decision=btn.hasAttribute('data-cancel-approve')?'approve':'reject';
      if(!confirm(decision==='approve'?'هل توافق على طلب إلغاء العقد؟ سيُحال بعدها إلى الإدارة لاعتماد التسوية.':'هل تريد رفض طلب إلغاء العقد؟'))return;
      try{btn.disabled=true;await api('respond_cancellation',{contractId:btn.dataset.cancelApprove||btn.dataset.cancelReject,decision});
        notice(decision==='approve'?'تمت الموافقة، وينتظر الطلب اعتماد الإدارة.':'تم رفض طلب الإلغاء.');await loadContracts();}
      catch(e){notice(e.message,true);btn.disabled=false;}
    });
  }

  let contractViewerLoadPromise=null;
  async function ensureContractDocumentViewer(){
    if(typeof window.showLimousineContractDocument==='function')return;
    if(!contractViewerLoadPromise)contractViewerLoadPromise=new Promise((resolve,reject)=>{
      const script=document.createElement('script');
      script.src='/shared/limousine-contract-document.js';
      script.onload=()=>typeof window.showLimousineContractDocument==='function'
        ?resolve():reject(new Error('تعذر تهيئة عارض العقد.'));
      script.onerror=()=>reject(new Error('تعذر تحميل عارض العقد.'));
      document.head.appendChild(script);
    });
    await contractViewerLoadPromise;
  }
  async function showContractDocument(contractId) {
    try {
      const d=await api('get_contract_document',{contractId});
      await ensureContractDocumentViewer();
      window.showLimousineContractDocument(d.contract||{});
    } catch(e){notice(e.message==='تعذر تحميل عارض العقد.'||e.message==='تعذر تهيئة عارض العقد.'
      ?'تعذر فتح العقد الآن. أعد تحميل الصفحة وحاول مرة أخرى.':e.message,true);}
  }
  async function loadChats() {
    const d=await api('list_contracts',{driverId:user.id,passengerId:user.id});
    const items=d.contracts||[];
    $('chats').innerHTML=items.length?items.map(c=>
      '<article class="card"><div class="line"><strong>محادثة عقد التأجير</strong><span class="pill">'+esc(statusNames[c.status]||c.status)+'</span></div>'+
      '<p><b>المدينة:</b> '+esc(c.city_name||c.pickup_area||'—')+' · <b>المدة:</b> '+Number(c.duration_days||0)+' يوم</p><p>'+date(c.start_at)+' — '+date(c.scheduled_end_at)+'</p>'+
      '<button class="small" data-open-chat="'+esc(c.id)+'">فتح المحادثة</button>'+
      '<div class="chat" id="chat-'+esc(c.id)+'" hidden><div class="messages" id="messages-'+esc(c.id)+'"></div><div class="line"><input id="msg-'+esc(c.id)+'" placeholder="اكتب رسالتك"><button class="small" data-send-chat="'+esc(c.id)+'">إرسال</button></div></div></article>'
    ).join(''):'<div class="empty">لا توجد محادثات حتى الآن.</div>';
    $('chats').querySelectorAll('[data-open-chat]').forEach(btn=>btn.onclick=async()=>{
      const c=btn.dataset.openChat,box=$('chat-'+c);box.hidden=!box.hidden;
      if(!box.hidden) await loadMessages(c);
    });
    $('chats').querySelectorAll('[data-send-chat]').forEach(btn=>btn.onclick=async()=>{
      const c=btn.dataset.sendChat,field=$('msg-'+c);
      try{await api('send_message',{contractId:c,message:field.value});field.value='';await loadMessages(c);}
      catch(e){notice(e.message,true);}
    });
  }

  async function loadMessages(contractId) {
    const d=await api('list_messages',{contractId});
    const target=$('messages-'+contractId);
    if(target) target.innerHTML=(d.messages||[]).map(m=>'<div class="message '+(m.sender_type===role?'mine':'')+'">'+esc(m.message)+'<small>'+date(m.created_at)+'</small></div>').join('');
  }
  function passengerSafeNotification(n) {
    if(role!=='passenger')return n;
    const copy={
      LIMO_FUNDING_PENDING:{title:'بانتظار اعتماد العقد',body:'تم اختيار السائق، وسيبدأ اعتماد العقد قبل موعد التأجير بـ20 ساعة.'},
      LIMO_DRIVER_SELECTED:{title:'تم اختيار السائق',body:'تم اختيار السائق، وسيبدأ اعتماد العقد قبل موعد التأجير بـ20 ساعة.'},
      LIMO_COMMISSION_RESERVED:{title:'تم اعتماد الحجز',body:'تم اعتماد العقد وأصبح الحجز مؤكداً.'},
      LIMO_BOOKING_CONFIRMED:{title:'تم اعتماد العقد',body:'تم اعتماد العقد وأصبح الحجز مؤكداً.'},
      LIMO_FUNDING_EXPIRED:{title:'انتهت مهلة اعتماد العقد',body:'لم يكتمل اعتماد العقد خلال المهلة المحددة، ويمكنك اختيار سائق بديل.'},
      LIMO_REQUEST_EXPIRED:{title:'انتهى موعد الطلب',body:'انتهى موعد بداية التأجير دون اختيار سائق، ولذلك أُغلق الطلب تلقائياً.'},
      LIMO_REQUEST_CANCELLED:{title:'تم إلغاء الطلب',body:'تم إلغاء طلب التأجير.'},
      LIMO_DRIVER_WITHDREW:{title:'سحب سائق قبوله',body:'سحب السائق قبوله لهذا الطلب. يمكنك اختيار سائق آخر من القائمة.'}
    };
    const mapped=copy[n.event_code];
    if(mapped)return {...n,...mapped};
    if(/عمولة|العموله|تأمين العمولة|تأمين عموله|حجز العمولة|خصم عمولة/.test(String(n.title||'')+' '+String(n.body||'')))
      return {...n,title:'تحديث عقد التأجير',body:'تم تحديث حالة عقد التأجير. يرجى مراجعة تفاصيل الحجز.'};
    return n;
  }
  async function loadNotifications() {
    const d=await api('list_notifications');
    const items=(d.notifications||[]).map(passengerSafeNotification);
    const unread=Number(d.unread_count||0),badge=$('unread-count'),preview=$('notification-preview');
    if(badge){badge.textContent=unread>99?'99+':String(unread);badge.hidden=unread===0;}
    if(preview){preview.textContent=unread>0?(items.find(n=>!n.read_at)?.body||'لديك تنبيه جديد').slice(0,90):'لا توجد تنبيهات غير مقروءة';preview.hidden=unread===0;}
    $('notifications').innerHTML=items.length?items.map(n=>
      '<div class="message"><div class="line"><b>'+esc(n.title)+'</b><small>'+date(n.created_at)+'</small></div><p>'+esc(n.body)+'</p>'+
      (n.read_at?'':'<button class="small" data-read="'+esc(n.id)+'">تمت القراءة</button>')+'</div>').join(''):'<div class="empty">لا توجد تنبيهات جديدة.</div>';
    $('notifications').querySelectorAll('[data-read]').forEach(btn=>btn.onclick=async()=>{
      try{await api('mark_notification_read',{notificationId:btn.dataset.read});await loadNotifications();}
      catch(e){notice(e.message,true);}
    });
  }
  let activeContract=null;
  function showActiveContractNotice(){
    const overlay=document.createElement('div');
    overlay.style.cssText='position:fixed;inset:0;z-index:99999;background:rgba(15,23,42,.62);display:grid;place-items:center;padding:20px;';
    const panel=document.createElement('div');
    panel.dir='rtl';
    panel.style.cssText='width:min(440px,100%);background:#fff;border-radius:20px;padding:24px 20px;text-align:center;box-shadow:0 24px 70px rgba(0,0,0,.28);border-top:6px solid #0f9b8e;font-family:Tajawal,sans-serif;';
    panel.innerHTML='<div style="font-size:38px;margin-bottom:8px">🚘</div><h2 style="margin:0 0 10px;color:#065f46">عقد الليموزين أصبح سارياً</h2><p style="line-height:1.9;color:#475569;margin:0 0 18px">'+(role==='passenger'?'اكتملت إجراءات التعاقد وأصبح العقد سارياً. ستجد تفاصيله في قسم العقود، وخلال مدة العقد لن يكون بإمكانك طلب رحلات داخلية أو سفرية.':'تم تأمين عمولة العقد بنجاح. أصبح العقد سارياً، وستظهر تفاصيله في بطاقته المخصصة. وخلال مدة العقد لن يكون بإمكانك طلب أو استقبال رحلات داخلية أو سفرية.')+'</p><button type="button" style="width:100%;border:0;border-radius:11px;padding:12px;background:#087e73;color:#fff;font:inherit;font-weight:800">حسناً</button>';
    panel.querySelector('button').onclick=()=>overlay.remove();
    overlay.appendChild(panel);document.body.appendChild(overlay);
  }
  function renderActiveContract(c){
    const card=$('limo-active-contract-banner');if(!card)return;
    activeContract=c;
    card.hidden=!c;
    if(!c)return;
    $('limo-active-car').textContent='عقد تأجير سيارة — '+(c.category_name||'سيارة');
    $('limo-active-model').textContent=c.car_model||'';
    $('limo-active-days').textContent=c.duration_days+' يوم';
    $('limo-active-completed').textContent=c.days_completed+' يوم';
    $('limo-active-remaining').textContent=c.days_remaining+' يوم';
    if($('limo-active-daily'))$('limo-active-daily').textContent=money(c.daily_price);
    if($('limo-active-total'))$('limo-active-total').textContent=money(c.total);
    $('limo-active-view').onclick=()=>showContractDocument(c.id);
    const seenKey='limo_active_contract_notice_'+c.id;
    if(!sessionStorage.getItem(seenKey)){
      sessionStorage.setItem(seenKey,'1');
      setTimeout(showActiveContractNotice,150);
    }
  }
  async function loadActiveContract(){
    const d=await api('get_active_contract');
    renderActiveContract(d.contract||null);
  }
  async function loadDriverFunding() {
    if(role!=='driver')return;
    if(!fundingRefreshTimer)fundingRefreshTimer=setInterval(()=>loadDriverFunding().catch(()=>{}),30000);
    const d=await api('list_driver_funding',{driverId:user.id}),item=(d.funding||[])[0],card=$('limo-funding-card');
    if(!card)return;
    if(!item){
      card.hidden=true;fundingDeadline=null;fundingContractId=null;fundingAttemptedAt=null;fundingExpiryProcessing=false;
      if(fundingClockTimer){clearInterval(fundingClockTimer);fundingClockTimer=null;}
      return;
    }
    fundingDeadline=item.funding_deadline;fundingContractId=item.id;
    fundingAttemptedAt=item.funding_attempted_at;
    $('limo-funding-required').textContent=money(item.commission_due);
    $('limo-funding-balance').textContent=money(d.balance);
    $('limo-funding-details').textContent=[
      item.category_name||'—',item.city_name||'—',date(item.start_at),
      Number(item.duration_days||0)+' يوم','اليوم '+money(item.daily_price_snapshot),
      'الإجمالي '+money(item.contract_value_snapshot),
      'العمولة '+Number(item.commission_rate_snapshot||0)+'%',
      'المطلوب '+money(item.commission_due)
    ].join(' · ');
    $('limo-funding-reminder').textContent='وفّر '+money(item.commission_due)+' على الأقل في رصيدك بحلول '+date(item.funding_deadline)+'.';
    card.hidden=false;updateFundingClock();
    if(!fundingClockTimer)fundingClockTimer=setInterval(updateFundingClock,1000);
  }
  async function attemptFundingRetry(slot){
    if(role!=='driver'||fundingRetryProcessing||!fundingContractId||!fundingDeadline)return;
    const contractId=fundingContractId,now=Date.now(),deadline=new Date(fundingDeadline).getTime();
    if(!Number.isFinite(deadline)||now>=deadline)return;
    const slotKey=contractId+':'+slot;
    if(fundingRetrySlots.has(slotKey))return;
    const marker='limo_funding_retry_'+contractId+'_'+slot;
    try{if(localStorage.getItem(marker)){fundingRetrySlots.add(slotKey);return;}}catch{}
    const lastKey='limo_funding_retry_last_'+contractId;
    let last=0;
    try{last=Number(localStorage.getItem(lastKey)||0);}catch{}
    if(slot!=='final'&&last&&now-last<60000){
      fundingRetrySlots.add(slotKey);
      try{localStorage.setItem(marker,String(now));}catch{}
      return;
    }
    fundingRetrySlots.add(slotKey);
    try{
      localStorage.setItem(marker,String(now));
      localStorage.setItem(lastKey,String(now));
    }catch{}
    fundingRetryProcessing=true;
    try{
      const response=await api('retry_driver_funding',{driverId:user.id,contractId});
      const result=response.result||{};
      if(result.status==='booked'||(result.ok===true&&result.held!==undefined)){
        fundingDeadline=null;fundingContractId=null;fundingAttemptedAt=null;
        const card=$('limo-funding-card');if(card)card.hidden=true;
        if(fundingClockTimer){clearInterval(fundingClockTimer);fundingClockTimer=null;}
        await Promise.all([driverRequests(),loadDriverFunding(),loadActiveContract()]);
        sectionLoaded.contracts=false;
        if(activeSection==='contracts')await loadContracts();
      }else if(Number.isFinite(Number(result.available))){
        $('limo-funding-balance').textContent=money(result.available);
        $('current-balance').textContent=money(result.available);
      }
    }catch{
      // A failed retry must not stop or reset the funding countdown.
    }finally{
      fundingRetryProcessing=false;
    }
  }
  async function processExpiredFunding(){
    if(fundingExpiryProcessing||!fundingContractId)return;
    fundingExpiryProcessing=true;
    const contractId=fundingContractId;
    try{
      await api('expire_driver_funding',{driverId:user.id,contractId});
      await driverRequests();
      await loadDriverFunding();
    }catch(e){
      fundingExpiryProcessing=false;
      const timer=$('limo-funding-timer');
      if(timer)timer.textContent='جارٍ تحديث حالة الطلب...';
      throw e;
    }finally{
      fundingExpiryProcessing=false;
    }
  }
  function updateFundingClock(){
    const timer=$('limo-funding-timer');if(!timer||!fundingDeadline)return;
    const remaining=Math.max(0,Math.floor((new Date(fundingDeadline).getTime()-Date.now())/1000));
    const h=Math.floor(remaining/3600),m=Math.floor((remaining%3600)/60),s=remaining%60;
    if(remaining){
      timer.textContent=[h,m,s].map(v=>String(v).padStart(2,'0')).join(':');
      if(remaining<=120000){
        attemptFundingRetry('final').catch(()=>{});
      }else if(fundingAttemptedAt){
        const attempted=new Date(fundingAttemptedAt).getTime();
        if(Number.isFinite(attempted)){
          const retrySlot=Math.floor((Date.now()-attempted)/600000);
          if(retrySlot>=1)attemptFundingRetry('periodic_'+retrySlot).catch(()=>{});
        }
      }
      return;
    }
    timer.textContent='جارٍ تحديث حالة الطلب...';
    processExpiredFunding().catch(()=>{fundingExpiryProcessing=false;});
  }

  async function loadSection(section, force=false) {
    if(sectionLoaded[section] && !force) return;
    if(role==='passenger' && section==='requests') await passengerRequests();
    if(role==='passenger' && section==='contracts') await loadContracts();
    if(role==='passenger' && section==='chats') await loadChats();
    if(role==='driver' && (section==='available'||section==='accepted')) await driverRequests();
    if(section==='notifications') await loadNotifications();
    if(role==='driver') await loadDriverFunding();
    await loadActiveContract();
    if(role==='driver' && section==='contracts') await loadContracts();
    if(role==='driver' && section==='chats') await loadChats();
    sectionLoaded[section]=true;
  }
  function showSection(section, button) {
    activeSection=section;
    document.querySelectorAll('[data-section-panel]').forEach(el=>el.hidden=el.dataset.sectionPanel!==section);
    document.querySelectorAll('[data-section-button]').forEach(el=>{
      const selected=el.dataset.sectionButton===section;
      el.classList.toggle('active',selected);
      el.setAttribute('aria-selected',selected?'true':'false');
    });
    loadSection(section).catch(e=>notice(e.message,true));
  }
  document.querySelectorAll('[data-section-button]').forEach(btn=>btn.addEventListener('click',()=>showSection(btn.dataset.sectionButton,btn)));
  $('refresh').onclick=()=>{sectionLoaded[activeSection]=false;loadSection(activeSection,true).catch(e=>notice(e.message,true));};
  if(role==='passenger'){
    $('request-form').onsubmit=async e=>{
      e.preventDefault();
      const submit=$('submit-request');submit.disabled=true;
      try{
        const cityId=$('city').value,categoryId=$('category').value,price=pricingFor(cityId,categoryId);
        if(!price)throw new Error('لا تتوفر خدمة التأجير لهذه المدينة وفئة السيارة حالياً.');
        const startDate=String($('start').value||'').trim();
        if(!/^\d{4}-\d{2}-\d{2}$/.test(startDate))throw new Error('حدد تاريخ بداية التأجير.');
        const [year,month,day]=startDate.split('-').map(Number),check=new Date(Date.UTC(year,month-1,day));
        if(check.getUTCFullYear()!==year||check.getUTCMonth()!==month-1||check.getUTCDate()!==day)throw new Error('تاريخ بداية التأجير غير صحيح.');
        const start=new Date(startDate+'T07:00:00+02:00'),days=Number($('days').value);
        if(!Number.isFinite(start.getTime())||start<=new Date())throw new Error('يجب أن يكون تاريخ بداية التأجير في المستقبل عند الساعة 7 صباحاً.');
        if(!Number.isInteger(days)||days<1||days>90||(price.max_days&&days>price.max_days))throw new Error('مدة التأجير يجب أن تكون يوماً كاملاً واحداً أو أكثر ضمن الحد المتاح.');
        await api('create_request',{passengerId:user.id,cityId,pickupArea:$('pickup').value,startDate,durationDays:days,categoryId,passengerCount:Number($('passengers').value),purpose:$('purpose').value,notes:$('notes').value});
        $('request-form').reset();updateEstimate();notice('تم نشر طلب التأجير للسائقين المؤهلين.');
        sectionLoaded.requests=false;
      }catch(e){notice(e.message,true);}
      finally{submit.disabled=false;}
    };
    ['city','category','days'].forEach(id=>$(id).addEventListener('change',updateEstimate));
  }
  if(requireLogin()){
    if(role==='passenger') setProfile(user.full_name || user.name || 'الراكب');
    Promise.all([
      loadNotifications(),
      loadActiveContract(),
      role==='passenger'?loadConfig():Promise.all([driverRequests(),loadDriverFunding()])
    ]).then(()=>{
      if(role==='driver') sectionLoaded.available=true;
      showSection(activeSection);
      const contractId=new URLSearchParams(location.search).get('contract');
      if(contractId)showContractDocument(contractId);
    }).catch(e=>notice(e.message,true));
    setInterval(()=>loadNotifications().catch(()=>{}),45000);
    setInterval(()=>{
      sectionLoaded[activeSection]=false;
      loadSection(activeSection,true).catch(()=>{});
    },60000);
  }
})();