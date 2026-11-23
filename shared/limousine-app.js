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
  let fundingRefreshTimer = null;
  let fundingClockTimer = null;
  const money = n => Math.round(Number(n || 0)).toLocaleString('en-US') + ' ج.س';
  const date = d => d ? new Date(d).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }) : '—';
  const statusNames = {
    open:'بانتظار قبول السائقين', awaiting_driver_selection:'بانتظار اختيار سائق',
    driver_selected:'تم اختيار السائق', confirmed:'مؤكد', awaiting_funding:'بانتظار تأمين العمولة',
    booked:'محجوز مالياً', active:'نشط', completion_requested:'طلب إنهاء الخدمة',
    awaiting_settlement:'بانتظار التسوية', settled:'تمت التسوية', disputed:'نزاع',
    cancelled:'ملغي', expired:'فات وقته', accepted:'قبول مبدئي', selected:'تم الاختيار', contracted:'تم التعاقد'
  };
  const errorNames = {
    'غير مصرح':'انتهت صلاحية الجلسة أو لا تملك صلاحية تنفيذ هذه العملية. يرجى تسجيل الدخول مجدداً.',
    'start_must_be_future':'موعد بداية التأجير يجب أن يكون في المستقبل.',
    'outside_service_hours':'الموعد خارج ساعات الخدمة المتاحة.',
    'invalid_duration':'مدة التأجير غير صالحة.',
    'invalid_request_details':'يرجى مراجعة بيانات طلب التأجير.',
    'pricing_unavailable':'لا يتوفر سعر لهذه المدينة وفئة السيارة حالياً.',
    'duration_out_of_pricing_range':'مدة التأجير خارج المدة المتاحة لهذه الفئة.',
    'request_not_available':'هذا الطلب لم يعد متاحاً للقبول.',
    'driver_not_eligible':'سيارتك غير مؤهلة لهذا الطلب.',
    'vehicle_category_not_eligible':'فئة السيارة لا تطابق الفئة المطلوبة.',
    'acceptance_limit_reached':'اكتمل عدد السائقين الذين يمكنهم قبول الطلب.',
    'driver_has_overlapping_limo_contract':'لديك عقد تأجير متداخل مع هذا الموعد.',
    'request_not_selectable':'لا يمكن اختيار هذا السائق لهذا الطلب.',
    'driver_has_not_accepted':'هذا السائق لم يقبل الطلب.',
    'insufficient_balance':'رصيد السائق غير كافٍ لتأمين العمولة.',
    'بيانات التواصل محجوبة حتى نجاح تأمين العمولة.':'ستظهر بيانات التواصل بعد تأمين العمولة بنجاح.'
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
    const p=pricingFor($('city').value,$('category').value), days=Math.max(1,Number($('days').value)||1);
    $('estimate').textContent=p ? 'السعر اليومي: '+money(p.daily_price)+' — الإجمالي التقديري: '+money(p.daily_price*days)+' — عمولة السائق: '+p.commission_rate+'%' : 'اختر المدينة وفئة السيارة لعرض السعر المتاح.';
  }
  function carDescription(d) {
    return [d.car_model || d.car_type || 'سيارة', d.car_color || ''].filter(Boolean).join(' · ');
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
        '<p>'+esc(r.pickup_area)+' — '+date(r.start_at)+'</p><p>'+r.duration_days+' يوم · '+money(r.estimated_total)+'</p>'+
        (acc.length?'<div class="driver-list"><b>السائقون الذين قبلوا ('+acc.length+')</b>'+driverCards+'</div>':'<p class="muted">بانتظار قبول السائقين.</p>')+
        (contract?'<p class="muted">العقد: '+esc(statusNames[contract.status]||contract.status)+'</p>':'')+'</article>';
    }).join('');
    list.querySelectorAll('[data-select]').forEach(btn=>btn.onclick=async()=>{
      try {
        btn.disabled=true;
        await api('select_driver',{passengerId:user.id,requestId:btn.dataset.select,driverId:btn.dataset.driver});
        notice('تم تسجيل اختيار السائق. يبدأ تأمين العمولة وفق الموعد المحدد قبل بداية التأجير.');
        await passengerRequests();
      } catch(e) { notice(e.message,true); btn.disabled=false; }
    });
  }
  function renderDriverRequests() {
    $('requests').innerHTML=requests.length?requests.map(r=>
      '<article class="card"><div class="line"><strong>طلب تأجير جديد</strong><span class="pill">'+esc(r.accepted_count)+' / 10 قبول</span></div>'+
      '<p>'+esc(r.pickup_area)+' · '+date(r.start_at)+'</p><p>'+r.duration_days+' يوم · '+money(r.estimated_total)+'</p>'+
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
      const label=expired?'فات وقته':fundingExpired?'انتهت مهلة تأمين العمولة':r.acceptance_status==='accepted'?'بانتظار اختيار الراكب':r.acceptance_status==='selected'?'تم اختيارك — بانتظار تأمين العمولة':'تم التعاقد';
      const detail=expired?'انتهى موعد بداية التأجير دون اختيار سائق وتأمين العمولة، وأُغلق الطلب تلقائياً.':fundingExpired?'لم يتم تأمين العمولة خلال المهلة، ويمكن للراكب اختيار سائق بديل.':r.acceptance_status==='accepted'?'ينتظر الطلب اختيار الراكب. لا يتم حجز العمولة عند القبول المبدئي.':r.acceptance_status==='selected'?'تم اختيارك لهذا الطلب. تبدأ إجراءات تأمين العمولة وفق موعد الحجز.':'راجع قسم العقود لمتابعة الحجز.';
      return '<article class="card"><div class="line"><strong>طلب قبلته</strong><span class="pill">'+label+'</span></div>'+
        '<p>'+esc(r.pickup_area)+' · '+date(r.start_at)+'</p><p>'+r.duration_days+' يوم · '+money(r.estimated_total)+'</p>'+
        '<p class="muted">'+detail+'</p></article>';
    }).join(''):'<div class="empty">لا توجد طلبات قبلتها وتنتظر اختيار الراكب.</div>';
  }
  async function driverRequests() {
    const data=await api('list_driver_requests',{driverId:user.id});
    requests=data.requests||[];
    acceptedRequests=data.accepted_requests||[];
    if (data.profile) setProfile(data.profile.full_name, data.profile.balance);
    renderDriverRequests();
    renderAcceptedRequests();
  }
  async function loadContracts() {
    const d=await api('list_contracts',{driverId:user.id,passengerId:user.id});
    contracts=d.contracts||[];
    $('contracts').innerHTML=contracts.length?contracts.map(c=>{
      const canView=Number(c.commission_held||0)>0 && ['active','completion_requested','awaiting_settlement','settled','disputed'].includes(c.status);
      return '<article class="card"><div class="line"><strong>عقد تأجير</strong><span class="pill">'+esc(statusNames[c.status]||c.status)+'</span></div>'+
      '<p><b>المدينة:</b> '+esc(c.city_name||c.pickup_area||'—')+'</p><p><b>بداية العقد:</b> '+date(c.start_at)+'</p>'+
      '<p><b>المدة:</b> '+Number(c.duration_days||0)+' يوم</p><p><b>نهاية العقد:</b> '+date(c.scheduled_end_at)+'</p>'+
      '<p><b>قيمة العقد:</b> '+money(c.contract_value_snapshot)+'</p>'+
      (canView?'<button class="primary" data-contract-document="'+esc(c.id)+'">عرض العقد الكامل</button>':'<p class="muted">سيظهر العقد الكامل بعد تأمين العمولة وبدء العقد.</p>')+
      (['booked','active','completion_requested','awaiting_settlement','settled','disputed'].includes(c.status)?'<button class="small" data-contact="'+esc(c.id)+'">عرض بيانات التواصل</button><div id="contact-'+esc(c.id)+'" class="muted" hidden></div>':'')+
      (c.status==='active'?'<button class="secondary" data-end="'+esc(c.id)+'">طلب إنهاء الخدمة</button>':'')+
      (['active','completion_requested','awaiting_settlement'].includes(c.status)?'<button class="small" data-dispute="'+esc(c.id)+'">رفع نزاع للإدارة</button>':'')+
      (c.status==='completion_requested' && c.end_requested_by!==role?'<button class="secondary" data-confirm-end="'+esc(c.id)+'">نعم، انتهت الخدمة</button><button class="small" data-reject-end="'+esc(c.id)+'">لا، لم تنتهِ الخدمة</button>':c.status==='completion_requested'?'<p class="muted">طلب الإنهاء بانتظار تأكيد الطرف الآخر.</p>':'')+
      (c.status==='awaiting_settlement'?'<p class="muted">تم تأكيد انتهاء الخدمة، والعقد بانتظار مراجعة الإدارة والتسوية.</p>':'')+'</article>';
    }).join(''):'<div class="empty">لا توجد عقود حتى الآن.</div>';
    $('contracts').querySelectorAll('[data-contract-document]').forEach(btn=>btn.onclick=()=>showContractDocument(btn.dataset.contractDocument));
    $('contracts').querySelectorAll('[data-contact]').forEach(btn=>btn.onclick=async()=>{
      const c=btn.dataset.contact,box=$('contact-'+c);if(!box.hidden){box.hidden=true;return;}
      try{const d=await api('get_contract_contact',{contractId:c}),x=d.contact||{};box.innerHTML='<p><b>'+esc(x.full_name||'')+'</b></p><p>'+esc(x.whatsapp_number||x.phone||'')+'</p><p>'+esc([x.car_model,x.car_type,x.car_color,x.car_plate_number].filter(Boolean).join(' · '))+'</p>';box.hidden=false;}
      catch(e){notice(e.message,true);}
    });
    $('contracts').querySelectorAll('[data-end]').forEach(btn=>btn.onclick=async()=>{if(!confirm('هل تؤكد طلب إنهاء خدمة التأجير؟'))return;try{await api('request_end',{contractId:btn.dataset.end});notice('أُرسل طلب الإنهاء للطرف الآخر للتأكيد.');await loadContracts();}catch(e){notice(e.message,true);}});
    $('contracts').querySelectorAll('[data-confirm-end]').forEach(btn=>btn.onclick=async()=>{if(!confirm('هل تؤكد أن خدمة التأجير قد انتهت فعلاً؟'))return;try{await api('confirm_end',{contractId:btn.dataset.confirmEnd});notice('تم تأكيد انتهاء الخدمة، والعقد بانتظار التسوية الإدارية.');await loadContracts();}catch(e){notice(e.message,true);}});
    $('contracts').querySelectorAll('[data-reject-end]').forEach(btn=>btn.onclick=async()=>{if(!confirm('هل تؤكد أن خدمة التأجير لم تنتهِ بعد وأن العقد سيظل نشطاً؟'))return;try{await api('reject_end',{contractId:btn.dataset.rejectEnd});notice('تم رفض طلب الإنهاء، وسيظل العقد نشطاً.');await loadContracts();}catch(e){notice(e.message,true);}});
    $('contracts').querySelectorAll('[data-dispute]').forEach(btn=>btn.onclick=async()=>{const reason=prompt('اكتب سبب النزاع باختصار:');if(reason===null)return;try{await api('raise_dispute',{contractId:btn.dataset.dispute,reason});notice('تم رفع النزاع للإدارة.');await loadContracts();}catch(e){notice(e.message,true);}});
  }

  async function showContractDocument(contractId) {
    try {
      const d=await api('get_contract_document',{contractId}),c=d.contract||{};
      const vehicle=[c.car_model,c.car_type,c.car_color,c.car_plate_number].filter(Boolean).join(' · ')||'غير محددة';
      const modal=document.createElement('div');modal.className='contract-document-overlay';modal.id='contract-document-modal';
      modal.innerHTML='<div class="contract-document-dialog"><div class="contract-document-actions"><button type="button" class="small" id="print-contract">تحميل / حفظ PDF</button><button type="button" class="secondary" id="close-contract">إغلاق</button></div>'+
        '<article class="contract-document" dir="rtl"><header><h1>منصة ليموزين تراكا</h1><h2>عقد تأجير سيارة بسائق</h2><p>رقم العقد: '+esc(c.id)+'</p></header>'+
        '<h3>أولاً: أطراف العقد</h3><p><b>الطرف الأول – الراكب:</b> '+esc(c.passenger_name||'—')+(c.passenger_phone?' · '+esc(c.passenger_phone):'')+'</p><p><b>الطرف الثاني – السائق:</b> '+esc(c.driver_name||'—')+(c.driver_phone?' · '+esc(c.driver_phone):'')+'</p>'+
        '<h3>ثانياً: بيانات التأجير</h3><p><b>المدينة:</b> '+esc(c.city_name||'—')+'</p><p><b>موقع الاستلام:</b> '+esc(c.pickup_area||'—')+'</p><p><b>فئة السيارة:</b> '+esc(c.category_name||'—')+'</p><p><b>السيارة:</b> '+esc(vehicle)+'</p>'+
        '<p><b>البداية:</b> '+date(c.start_at)+'</p><p><b>النهاية:</b> '+date(c.scheduled_end_at)+'</p><p><b>المدة:</b> '+Number(c.duration_days||0)+' يوم</p><p><b>عدد الركاب:</b> '+Number(c.passenger_count||1)+'</p><p><b>غرض الاستخدام:</b> '+esc(c.usage_purpose||'—')+'</p><p><b>ملاحظات الطلب:</b> '+esc(c.request_notes||'لا توجد')+'</p><p><b>حالة العقد:</b> '+esc(statusNames[c.status]||c.status)+'</p>'+
        '<h3>ثالثاً: القيمة والعمولة</h3><p><b>السعر اليومي:</b> '+money(c.daily_price_snapshot)+'</p><p><b>إجمالي العقد:</b> '+money(c.contract_value_snapshot)+'</p><p><b>نسبة العمولة:</b> '+Number(c.commission_rate_snapshot||0)+'%</p><p><b>العمولة المؤمّنة:</b> '+money(c.commission_held)+'</p>'+
        '<h3>رابعاً: الشروط والالتزامات</h3><ol><li>يلتزم السائق بتوفير السيارة المتفق عليها وخدمة النقل طوال المدة والمواعيد المحددة.</li><li>يلتزم الراكب بسداد قيمة التأجير المتفق عليها وفق آلية الدفع المعتمدة بين الطرفين.</li><li>لا يجوز تغيير مدة التأجير أو نطاق الخدمة إلا بموافقة الطرفين وتوثيق التعديل عبر المنصة.</li><li>يتم توثيق إنهاء الخدمة وموافقة الطرف الآخر عبر المنصة، وتُجرى التسوية وفق المدة المنفذة والضوابط المعتمدة.</li><li>تُستخدم المحادثة داخل المنصة لتوثيق التواصل المتعلق بالعقد، ويُحال الخلاف إلى إدارة تراكا.</li></ol>'+
        '<h3>خامساً: اعتماد العقد</h3><p>هذا المستند ملخص لبيانات التعاقد المسجلة في منصة ليموزين تراكا، وقد تم تأمين العمولة الموضحة أعلاه.</p><div class="contract-signatures"><div>توقيع الراكب: __________________</div><div>توقيع السائق: __________________</div></div><footer>صدر إلكترونياً من منصة ليموزين تراكا · '+date(new Date().toISOString())+'</footer></article></div>';
      document.body.appendChild(modal);$('close-contract').onclick=()=>modal.remove();
      $('print-contract').onclick=async()=>{
        const button=$('print-contract');button.disabled=true;
        try{
          if(!window.html2pdf){
            await new Promise((resolve,reject)=>{
              const script=document.createElement('script');
              script.src='https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js';
              script.onload=resolve;script.onerror=reject;document.head.appendChild(script);
            });
          }
          await window.html2pdf().set({
            margin:10,
            filename:'limousine-contract-'+String(c.id||'contract').slice(0,8)+'.pdf',
            image:{type:'jpeg',quality:0.98},
            html2canvas:{scale:2,useCORS:true,backgroundColor:'#ffffff'},
            jsPDF:{unit:'mm',format:'a4',orientation:'portrait'},
            pagebreak:{mode:['css','legacy']}
          }).from(modal.querySelector('.contract-document')).save();
        }catch(error){
          notice('تعذر تنزيل PDF مباشرة. يمكنك حفظ نسخة PDF من نافذة الطباعة.',true);
          window.print();
        }finally{button.disabled=false;}
      };
      if(!document.getElementById('contract-print-style')){const style=document.createElement('style');style.id='contract-print-style';style.textContent='.contract-document-overlay{position:fixed;inset:0;z-index:99999;background:rgba(15,23,42,.72);overflow:auto;padding:14px;display:flex;justify-content:center;align-items:flex-start}.contract-document-dialog{background:#fff;color:#172033;border-radius:14px;width:100%;max-width:760px;padding:14px;max-height:95vh;overflow:auto}.contract-document-actions{display:flex;gap:8px;justify-content:flex-end;margin-bottom:12px}.contract-document{font-family:Tajawal,Arial,sans-serif;line-height:1.9;color:#172033}.contract-document header{text-align:center;border-bottom:2px solid #0d9488;padding-bottom:10px}.contract-document h1{color:#087e73;margin:0}.contract-document h2{margin:4px 0}.contract-document h3{background:#e8f4f2;padding:6px 10px;border-radius:6px;margin:18px 0 8px}.contract-signatures{display:grid;grid-template-columns:1fr 1fr;gap:18px;margin:28px 0}.contract-document footer{text-align:center;border-top:1px solid #ddd;padding-top:10px;font-size:11px;color:#64748b}@media print{body *{visibility:hidden!important}#contract-document-modal,#contract-document-modal *{visibility:visible!important}#contract-document-modal{position:absolute!important;inset:0!important;padding:0!important;background:#fff!important;overflow:visible!important;display:block!important}#contract-document-modal .contract-document-dialog{max-width:none!important;max-height:none!important;overflow:visible!important;border:0!important;border-radius:0!important;box-shadow:none!important;padding:0!important}#contract-document-modal .contract-document-actions{display:none!important}.contract-document{font-size:12pt!important}}';document.head.appendChild(style);}
    } catch(e){notice(e.message,true);}
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
  async function loadNotifications() {
    const d=await api('list_notifications');
    const items=d.notifications||[];
    const unread=Number(d.unread_count||0),badge=$('unread-count'),preview=$('notification-preview');
    if(badge){badge.textContent=unread>99?'99+':String(unread);badge.hidden=unread===0;}
    if(preview){preview.textContent=unread>0?(d.last_unread?.body||items.find(n=>!n.read_at)?.body||'لديك تنبيه جديد').slice(0,90):'لا توجد تنبيهات غير مقروءة';preview.hidden=unread===0;}
    $('notifications').innerHTML=items.length?items.map(n=>
      '<div class="message"><div class="line"><b>'+esc(n.title)+'</b><small>'+date(n.created_at)+'</small></div><p>'+esc(n.body)+'</p>'+
      (n.read_at?'':'<button class="small" data-read="'+esc(n.id)+'">تمت القراءة</button>')+'</div>').join(''):'<div class="empty">لا توجد تنبيهات جديدة.</div>';
    $('notifications').querySelectorAll('[data-read]').forEach(btn=>btn.onclick=async()=>{
      try{await api('mark_notification_read',{notificationId:btn.dataset.read});await loadNotifications();}
      catch(e){notice(e.message,true);}
    });
  }
  async function loadDriverFunding() {
    if(role!=='driver')return;
    if(!fundingRefreshTimer)fundingRefreshTimer=setInterval(()=>loadDriverFunding().catch(()=>{}),30000);
    const d=await api('list_driver_funding',{driverId:user.id}),item=(d.funding||[])[0],card=$('limo-funding-card');
    if(!card)return;
    if(!item){card.hidden=true;fundingDeadline=null;return;}
    fundingDeadline=item.funding_deadline;$('limo-funding-required').textContent=money(item.commission_due);$('limo-funding-balance').textContent=money(d.balance);card.hidden=false;updateFundingClock();
    if(!fundingClockTimer)fundingClockTimer=setInterval(updateFundingClock,1000);
  }
  function updateFundingClock(){
    const timer=$('limo-funding-timer');if(!timer||!fundingDeadline)return;
    const remaining=Math.max(0,Math.floor((new Date(fundingDeadline).getTime()-Date.now())/1000));
    const h=Math.floor(remaining/3600),m=Math.floor((remaining%3600)/60),s=remaining%60;
    timer.textContent=remaining?[h,m,s].map(v=>String(v).padStart(2,'0')).join(':'):'انتهت المهلة — جارٍ تحديث الحالة';
  }

  async function loadSection(section, force=false) {
    if(sectionLoaded[section] && !force) return;
    if(role==='passenger' && section==='requests') await passengerRequests();
    if(role==='passenger' && section==='contracts') await loadContracts();
    if(role==='passenger' && section==='chats') await loadChats();
    if(role==='driver' && (section==='available'||section==='accepted')) await driverRequests();
    if(section==='notifications') await loadNotifications();
    if(role==='driver') await loadDriverFunding();
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
        if(!price)throw new Error('لا يوجد سعر محدد لهذه المدينة وفئة السيارة.');
        const start=new Date($('start').value);
        if(!Number.isFinite(start.getTime())||start<=new Date())throw new Error('حدد موعد بداية في المستقبل.');
        const days=Number($('days').value);
        if(days<price.min_days||(price.max_days&&days>price.max_days))throw new Error('مدة التأجير خارج المدة المتاحة لهذه الفئة.');
        await api('create_request',{passengerId:user.id,cityId,pickupArea:$('pickup').value,startAt:start.toISOString(),durationDays:days,categoryId,passengerCount:Number($('passengers').value),purpose:$('purpose').value,notes:$('notes').value});
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
      role==='passenger'?loadConfig():Promise.all([driverRequests(),loadDriverFunding()])
    ]).then(()=>{
      if(role==='driver') sectionLoaded.available=true;
      showSection(activeSection);
    }).catch(e=>notice(e.message,true));
    setInterval(()=>loadNotifications().catch(()=>{}),45000);
    setInterval(()=>{
      sectionLoaded[activeSection]=false;
      loadSection(activeSection,true).catch(()=>{});
    },60000);
  }
})();