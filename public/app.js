'use strict';
(() => {
  const DAY = 86400000;
  const loadedAt = Date.now();
  const defaultStart = Date.UTC(2026, 7, 10);
  let userZoomed = false, restoringZoom = false;
  const $ = id => document.getElementById(id);
  let data = null, unit = 'tao', range = 'default', chart = null, loading = false, fetchError = '';
  const savedTheme = localStorage.getItem('subnet-theme');
  let theme = savedTheme === 'light' || savedTheme === 'dark' ? savedTheme : 'dark';
  const num = (v, digits = 0) => Number(v).toLocaleString('en-US', {maximumFractionDigits: digits});
  const ts = v => typeof v === 'number' ? (v < 1e11 ? v * 1000 : v) : Date.parse(v);
  const escape = v => String(v).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const date = (v, full = false) => new Intl.DateTimeFormat('en-GB', {timeZone:'UTC', day:'numeric',month:'short', ...(full ? {year:'numeric',hour:'2-digit',minute:'2-digit'} : {})}).format(ts(v));
  const age = v => {
    const delta = Math.max(0, Date.now() - ts(v));
    if (!Number.isFinite(delta)) return 'unavailable';
    if (delta < 60000) return 'just now';
    if (delta < 3600000) return `${Math.floor(delta / 60000)}m ago`;
    if (delta < DAY) return `${Math.floor(delta / 3600000)}h ago`;
    return `${Math.floor(delta / DAY)}d ago`;
  };
  const rate = () => typeof data?.usd === 'object' ? Number(data.usd.price ?? data.usd.value) : Number(data?.usd);
  const usdAvailable = () => Number.isFinite(rate()) && rate() > 0;
  const convert = v => Number(v) * (unit === 'usd' ? rate() : 1);
  const price = v => `${unit === 'usd' ? '$' : ''}${num(convert(v), 2)}${unit === 'tao' ? ' TAO' : ''}`;
  const colors = () => {
    const c = getComputedStyle(document.documentElement);
    return Object.fromEntries(['text','muted','dim','border','grid','accent','blue','red','panel'].map(key=>[key,c.getPropertyValue(`--${key}`).trim()]));
  };
  function trendBounds(t) {
    const tr=data.trend;
    if(tr.policy==='fan') {
      const central=Number(tr.intercept)+Number(tr.slope)*(t-ts(tr.origin))/DAY;
      const dt=Math.max(0,(t-ts(tr.last_paid))/DAY), widening=Number(tr.fan_curvature)*dt*dt;
      const lower=central+Number(tr.low)-widening, upper=central+Number(tr.high)+widening;
      const extra=Number(tr.buffer_extra)+(Number(tr.buffer_multiplier)-1)*widening;
      return {central:Math.max(0,central),lower:Math.max(0,lower),upper:Math.max(0,upper),buffer:Math.max(0,upper+extra),bufferLower:Math.max(0,lower-extra)};
    }
    const base = Number(tr.intercept) + Number(tr.slope) * (t-ts(tr.origin))/DAY;
    const lower = base + Number(tr.low);
    const upper = Math.max(base+Number(tr.high), lower+Math.max(0,base)*Number(tr.minimum_width_fraction || 0));
    return {central:Math.max(0,Number(tr.central_intercept ?? tr.intercept)+Number(tr.slope)*(t-ts(tr.origin))/DAY),lower:Math.max(0,lower),upper:Math.max(0,upper),buffer:Math.max(0,upper+Math.max(Number(tr.buffer_extra || 0),Math.max(0,base)*Number(tr.minimum_buffer_fraction || 0)))};
  }
  function applyTheme() {
    document.documentElement.dataset.theme = theme;
    $('theme-icon').textContent = theme === 'dark' ? '☀' : '☾';
    $('theme-label').textContent = theme === 'dark' ? 'Light' : 'Dark';
    $('theme-toggle').setAttribute('aria-label', `Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`);
    localStorage.setItem('subnet-theme', theme);
    if (data) renderChart(true);
  }
  function updateMeta() {
    if (!data) return;
    const current = data.current;
    $('current-value').innerHTML = unit === 'tao' ? `${num(current.price, 2)}<small>TAO</small>` : `$${num(convert(current.price), 0)}<small>USD</small>`;
    $('current-detail').textContent = `${unit === 'tao' ? (usdAvailable() ? `≈ $${num(current.price * rate(), 0)} USD` : 'USD unavailable') : `${num(current.price, 2)} TAO`} · Chain reading ${age(data.current_at ?? current.time)}`;
    $('decay-value').innerHTML = data.rate == null ? '—' : `${unit === 'usd' ? '$' : ''}${num(convert(Math.abs(Number(data.rate))), 1)}<small>${unit === 'tao' ? 'TAO / day' : '/ day'}</small>`;
    const entry = (data.markers || []).find(m => m.edge === 'buffer upper edge' && ts(m.time) >= ts(current.time));
    $('crossing-value').textContent = entry ? (/Already|reached/.test(entry.label) ? 'Reached now' : date(entry.time)) : !data.projection.length ? 'Unavailable' : 'No crossing';
    $('crossing-detail').textContent = entry ? (/Already|reached/.test(entry.label) ? 'Current quote is at or below the buffer upper edge' : `${date(entry.time, true)} UTC · buffer upper edge · if decay continues`) : !data.projection.length ? 'Projection is currently unavailable' : 'No future trend-band entry in this projection';
    $('chart-subtitle').textContent = `Historical cost and conditional projection · UTC${unit === 'usd' ? ' · latest TAO/USD conversion' : ''}`;
    const stale = Date.now() - ts(data.current_at ?? current.time) > 20 * 60000;
    $('status-dot').className = `status-dot ${stale || fetchError ? 'stale' : 'fresh'}`;
    $('status-label').textContent = fetchError ? 'Showing last available data' : stale ? 'Chain reading is delayed' : `Chain updated ${age(data.current_at ?? current.time)}`;
    const warnings = (data.warnings || []).map(w => typeof w === 'string' ? w : w.message).filter(Boolean);
    if (stale) warnings.unshift('The chain reading is over 20 minutes old. Treat the displayed current cost and projection as delayed.');
    if (fetchError) warnings.unshift(fetchError);
    $('notice').hidden = warnings.length === 0;
    $('notice').textContent = [...new Set(warnings)].join(' ');
    $('freshness-details').textContent = `Chain: ${age(data.current_at ?? current.time)} · History: ${age(data.history_at)} · TAO/USD: ${age(data.usd_at)}. Current cost refreshes about every 5 minutes.`;
    $('usd-rate').textContent = usdAvailable() ? `1 TAO ≈ $${num(rate(), 2)} · All dates in UTC` : 'TAO/USD currently unavailable · All dates in UTC';
    const referenceMarkers = (data.markers || []).filter(m => m.edge || /range|last/i.test(m.label));
    $('reference-windows').textContent = referenceMarkers.length ? `Conditional windows · ${referenceMarkers.map(m => `${m.edge === 'buffer upper edge' ? 'Earliest likely · buffer upper edge' : m.edge ? 'Main fan upper edge' : 'Last 8 range'}: ${date(m.time, true)} UTC`).join(' · ')}` : 'Conditional reference windows: currently unavailable.';
    const b = data.trend ? trendBounds(ts(current.time)) : null;
    $('chart-now').textContent = `Now ≈ ${price(current.price)}${unit === 'tao' && usdAvailable() ? ` (≈ $${num(current.price*rate())})` : ''}`;
    $('budget-detail').textContent = b ? `At the current time: budget for up to ${num(b.buffer,0)} TAO${usdAvailable() ? ` ≈ $${num(b.buffer*rate(),0)}` : ''} · buffer upper edge` : 'Budget buffer currently unavailable';
    $('floor-explanation').textContent = data.floor != null && Number.isFinite(Number(data.floor)) ? `The dashed path stops at the chain minimum of ${num(data.floor, 2)} TAO (read ${age(data.floor_at)}).` : 'The chain minimum is currently unavailable; any shown endpoint is illustrative.';
    $('source-details').textContent = `Current cost: Finney chain · History & TAO/USD: Taostats · ${data.registrations.length} observed registrations`;
  }
  function defaultEnd(end) {
    // Show the forecast until the dashed decay line has passed through the whole fan (below its lower buffer edge), plus a small margin.
    const now = Date.now();
    if (!data.trend || !data.projection.length) return Math.min(end, Math.max(now, ...data.projection.map(p => ts(p[0]))));
    let exit = null;
    for (const p of data.projection) {
      const t = ts(p[0]); if (t < now) continue;
      const b = trendBounds(t);
      if (Number(p[1]) < (b.bufferLower ?? b.lower)) { exit = t; break; }
    }
    const last = ts(data.projection[data.projection.length - 1][0]);
    return Math.min(end, Math.max(now + DAY, (exit ?? last) + DAY / 2));
  }
  function viewBounds() {
    const currentTime = ts(data.current.time);
    const first = data.pts.length ? ts(data.pts[0][0]) : currentTime - DAY;
    const end = Math.max(currentTime + DAY, ...data.projection.map(p => ts(p[0])));
    return {start:range === 'default' ? defaultStart : range === 'all' ? first : Math.max(first, currentTime - Number(range) * DAY), end, visibleEnd:range === 'default' ? defaultEnd(end) : end};
  }
  function tooltip(params) {
    const entries = Array.isArray(params) ? params : [params];
    const useful = entries.filter(p => !['Trend lower','Trend upper','Conservative band','Uncertainty buffer','Central trend','Last 8 range'].includes(p.seriesName));
    if (!useful.length) return '';
    const x = useful[0].value?.[0];
    let html = `<div class="tooltip-title">${escape(date(x, true))} UTC</div>`;
    for (const p of useful) {
      const tao = Number(p.value?.[2] ?? p.value?.[1] / (unit === 'usd' ? rate() : 1));
      if (!Number.isFinite(tao)) continue;
      const inferred = p.seriesName === 'Registration cost' ? (data.synthetic_points || []).find(item => ts(item.time) === Number(p.value?.[0])) : null;
      const label = inferred ? 'Inferred pre-registration cost' : p.data?.eventLabel || p.seriesName;
      html += `<div class="tooltip-row"><span><i class="tooltip-color" style="background:${escape(typeof p.color === 'string' ? p.color : colors().blue)}"></i>${escape(label)}</span><strong>${num(tao, 2)} TAO</strong></div><div class="tooltip-row"><span>Latest USD conversion</span><span>${usdAvailable() ? `≈ $${num(tao * rate(), 2)}` : 'Unavailable'}</span></div>`;
      if (inferred) html += `<div class="tooltip-note">${escape(inferred.source || 'Inferred pre-jump cost, reconstructed from the post-registration quote.')}</div>`;
      if (p.data?.source) html += `<div class="tooltip-note">${escape(p.data.source)}</div>`;
    }
    if (useful.some(p => /projection|decay|band entry/i.test(p.seriesName + (p.data?.eventLabel || '')))) html += '<div class="tooltip-note">Conditional on no new registration and the current decay continuing.</div>';
    if (data.trend && Number.isFinite(Number(x))) {
      const b=trendBounds(Number(x));
      html += `<div class="tooltip-note">Reference estimates at this time</div>`;
      for (const [label,v] of [['Central estimate',b.central],['Main band lower',b.lower],['Main band upper',b.upper],['Buffer lower',b.bufferLower ?? b.lower],['Budget for up to · buffer upper',b.buffer]]) html += `<div class="tooltip-row"><span>${label}</span><strong>${num(v)} TAO${usdAvailable() ? ` ≈ $${num(v*rate())}` : ''}</strong></div>`;
    }
    return html;
  }
  function scaleVisibleYAxis() {
    if (!chart || !data) return;
    const zoom = chart.getOption().dataZoom?.[0];
    const bounds = viewBounds();
    const start = Number(zoom?.startValue ?? bounds.start), end = Number(zoom?.endValue ?? bounds.visibleEnd);
    const values = [...data.pts, ...data.projection, ...data.registrations.map(r=>[r.time,r.price]), [data.current.time,data.current.price]]
      .filter(p=>ts(p[0])>=start && ts(p[0])<=end).map(p=>Number(p[1]));
    if (data.trend) for (const t of [start,end]) values.push(trendBounds(t).buffer);
    
    const step = unit === 'usd' ? 10000 : 100;
    const max = Math.ceil(convert(Math.max(1,...values.filter(Number.isFinite)))*1.12/step)*step;
    chart.setOption({yAxis:{max}});
  }
  function renderChart(preserveZoom = false) {
    if (!chart || !data) return;
    const c = colors(), mobile = innerWidth < 620, bounds = viewBounds();
    const oldZoom = preserveZoom && userZoomed ? chart.getOption()?.dataZoom : null;
    const points = data.pts.map(p => [ts(p[0]), convert(p[1]), Number(p[1])]);
    const projection = data.projection.map(p => [ts(p[0]), convert(p[1]), Number(p[1])]);
    const trend = data.trend;
    const trendPts = [];
    const minTime = points.length ? points[0][0] : bounds.start;
    const fanStart=trend?.policy==='fan' ? Math.max(minTime,ts(trend.origin)) : minTime;
    if (trend && trend.slope != null && Number.isFinite(Number(trend.slope))) {
      const times=Array.from({length:361},(_,i)=>fanStart+(bounds.end-fanStart)*i/360);
      if(trend.last_paid) times.push(ts(trend.last_paid));
      data.registrations.filter(r=>ts(r.time)>=fanStart).forEach(r=>times.push(ts(r.time)));
      for(const t of [...new Set(times)].sort((a,b)=>a-b)) {
        const b=trendBounds(t);trendPts.push([t,b.lower,b.upper,b.buffer,b.central,b.bufferLower ?? b.lower]);
      }
    }
    const ribbon = (name,lo,hi,fill) => {
      const poly=trendPts.map(p=>[p[0],convert(p[lo])]).concat([...trendPts].reverse().map(p=>[p[0],convert(p[hi])]));
      return {name,type:'custom',silent:true,z:name==='Uncertainty buffer' ? 0 : 1,itemStyle:{color:fill},data:poly.length ? [0] : [],renderItem:(params,api)=>({type:'polygon',shape:{points:poly.map(p=>api.coord(p))},style:{fill},clipPath:{type:'rect',shape:{x:params.coordSys.x,y:params.coordSys.y,width:params.coordSys.width,height:params.coordSys.height}}})};
    };
    // Prioritise window markers, then deduplicate dates. Daily labels need
    // at least 45px; desktop labels appear no more often than every two days.
    const seen=new Set(), labelTimes=[];
    const ordered=[...(data.markers || [])].sort((a,b)=>Number(Boolean(b.edge))-Number(Boolean(a.edge)));
    const markerData=ordered.map(m=>{
      const t=ts(m.time), key=date(t), special=Boolean(m.edge)||/range|last/i.test(m.label);
      const spaced=m.edge==='conservative upper edge' || labelTimes.every(x=>Math.abs(x-t)/(bounds.end-bounds.start)*(innerWidth-140)> (mobile ? 64 : 55));
      const eligible=special || (!mobile && new Date(t).getUTCDate()%2===0 && !/minimum/i.test(m.label));
      const show=eligible && !seen.has(key) && spaced;
      if(show){seen.add(key);labelTimes.push(t);}
      return {value:[t,convert(m.price),Number(m.price)],eventLabel:m.label,label:{show,formatter:m.edge==='buffer upper edge' ? `Safe · buffer\n${date(t)}` : m.edge ? `Main fan\n${date(t)}` : /range|last/i.test(m.label) ? `Range\n${date(t)}` : date(t),position:m.edge==='conservative upper edge' ? 'bottom' : 'top',color:c.muted,fontSize:9,distance:12}};
    });
    const series = [ribbon('Conservative band',1,2,theme==='dark' ? '#68a9fb50' : '#357fd74d'),
      ribbon('Uncertainty buffer',5,3,theme==='dark' ? '#a7d9ff38' : '#75bce645'),
      {name:'Central trend',type:'line',data:trendPts.map(p=>[p[0],convert(p[4])]),symbol:'none',silent:true,lineStyle:{color:c.blue,width:1,type:'dotted',opacity:.65},z:2},
      {name:'Trend lower',type:'line',data:trendPts.map(p=>[p[0],convert(p[1])]),symbol:'none',silent:true,lineStyle:{color:c.blue,width:1,opacity:.45},z:1},
      {name:'Trend upper',type:'line',data:trendPts.map(p=>[p[0],convert(p[2])]),symbol:'none',silent:true,lineStyle:{color:c.blue,width:1,opacity:.45},z:1},
      {name:'Registration cost',type:'line',data:points,symbol:'none',lineStyle:{color:c.accent,width:2.3},itemStyle:{color:c.accent},z:3},
      {name:'Registrations',type:'scatter',data:data.registrations.map(r=>({value:[ts(r.time),convert(r.price),Number(r.price)],eventLabel:`Registration · ${r.inferred ? 'estimated' : 'observed'} price paid`,source:r.source})),symbolSize:mobile ? 7 : 8,itemStyle:{color:c.red,borderColor:c.panel,borderWidth:1.5},z:5},
      {name:'Decay projection',type:'line',data:projection,symbol:'none',lineStyle:{color:c.muted,width:1.7,type:'dashed'},itemStyle:{color:c.muted},z:3},
      {name:'Dated projection markers',type:'scatter',labelLayout:{hideOverlap:true},data:markerData,symbolSize:5,itemStyle:{color:c.muted},z:4},
      {name:'Now',type:'scatter',labelLayout:{hideOverlap:true},data:[{value:[ts(data.current.time),convert(data.current.price),Number(data.current.price)],eventLabel:'Current chain cost',source:data.current.source}],symbolSize:9,itemStyle:{color:c.accent,borderColor:c.panel,borderWidth:2},label:{show:false},z:6}
    ];
    chart.setOption({animation:false,backgroundColor:'transparent',textStyle:{fontFamily:'Inter, system-ui, sans-serif',color:c.muted},grid:{left:mobile ? 58 : 77,right:mobile ? 24 : 40,top:mobile ? 88 : 66,bottom:87},legend:{data:['Registration cost','Registrations','Conservative band','Uncertainty buffer','Decay projection'],top:16,left:mobile ? 16 : 27,textStyle:{color:c.muted,fontSize:mobile ? 9 : 10},itemWidth:mobile ? 13 : 18,itemHeight:7,itemGap:mobile ? 12 : 22,selectedMode:true},tooltip:{trigger:'axis',confine:true,position:(point,params,dom,rect,size)=>[Math.max(0,Math.min(point[0]-size.contentSize[0]/2,size.viewSize[0]-size.contentSize[0])),size.viewSize[1]-size.contentSize[1]-5],backgroundColor:c.panel,borderColor:c.border,textStyle:{color:c.text,fontSize:12},extraCssText:'max-width:360px;white-space:normal;box-shadow:0 8px 32px #0003;border-radius:9px;padding:14px;',axisPointer:{type:'line',lineStyle:{color:c.dim,type:'dashed'}},formatter:tooltip},xAxis:{type:'time',min:minTime,max:bounds.end,axisLine:{lineStyle:{color:c.border}},axisTick:{show:false},axisLabel:{color:c.dim,fontSize:10,hideOverlap:true,formatter:v=>date(v)},splitLine:{show:false}},yAxis:{type:'value',min:0,name:unit === 'tao' ? 'TAO' : 'USD · latest rate',nameTextStyle:{color:c.dim,fontSize:9,align:'left'},nameGap:20,axisLabel:{color:c.dim,fontSize:10,formatter:v=>unit === 'usd' ? (v>=1000000 ? `$${num(v/1000000,1)}m` : `$${num(v/1000,0)}k`) : num(v)},axisLine:{show:false},axisTick:{show:false},splitLine:{lineStyle:{color:c.grid,type:'dashed',opacity:.65}}},dataZoom:[{type:'inside',startValue:bounds.start,endValue:bounds.visibleEnd,filterMode:'none',zoomOnMouseWheel:true,moveOnMouseWheel:false,preventDefaultMouseMove:true},{type:'slider',startValue:bounds.start,endValue:bounds.visibleEnd,filterMode:'none',bottom:18,height:23,left:mobile ? 58 : 77,right:mobile ? 24 : 40,borderColor:c.border,backgroundColor:'transparent',fillerColor:theme === 'dark' ? '#87beff0c' : '#226bc00c',dataBackground:{lineStyle:{color:c.dim,opacity:.5},areaStyle:{color:c.dim,opacity:.08}},selectedDataBackground:{lineStyle:{color:c.accent,opacity:.7},areaStyle:{color:c.accent,opacity:.12}},handleStyle:{color:c.panel,borderColor:c.dim},textStyle:{color:c.muted,fontSize:9},labelFormatter:v=>date(v)}],series}, {notMerge:true});
    if (oldZoom?.[0] && Number.isFinite(Number(oldZoom[0].startValue))) {restoringZoom = true; chart.dispatchAction({type:'dataZoom',startValue:Number(oldZoom[0].startValue),endValue:Number(oldZoom[0].endValue)}); restoringZoom = false;}
    scaleVisibleYAxis();
    $('chart-empty').hidden = true;
  }
  async function refresh() {
    if (loading) return;
    loading = true;
    try {
      const response = await fetch('/api/data', {cache:'no-store',signal:AbortSignal.timeout(20000)});
      if (!response.ok) throw new Error(`Data service returned ${response.status}`);
      const next = await response.json();
      if (!next.current || !Number.isFinite(Number(next.current.price)) || !Array.isArray(next.pts)) throw new Error('Data service is not ready');
      next.registrations ||= []; next.projection ||= []; next.markers ||= [];
      data = next; fetchError = '';
      const usdOkay = Number.isFinite(rate()) && rate() > 0;
      document.querySelector('[data-unit="usd"]').disabled = !usdOkay;
      if (!usdOkay) {unit = 'tao';document.querySelectorAll('[data-unit]').forEach(b=>{b.classList.toggle('active',b.dataset.unit==='tao');b.setAttribute('aria-pressed',String(b.dataset.unit==='tao'));});data.warnings ||= [];data.warnings.push('TAO/USD conversion is currently unavailable.');}
      updateMeta(); renderChart(true);
    } catch (error) {
      fetchError = 'The latest data could not be retrieved. Retrying automatically every minute.';
      if (data) updateMeta();
      else {
        $('status-label').textContent = 'Waiting for data service';
        $('status-dot').className = 'status-dot stale';
        $('notice').hidden = false; $('notice').textContent = fetchError;
        $('chart-empty').innerHTML = 'Network data is temporarily unavailable<span>This page will retry automatically.</span>';
      }
    } finally {loading = false;}
  }
  document.querySelectorAll('[data-range]').forEach(button=>button.addEventListener('click',()=>{
    range = button.dataset.range; userZoomed = false;
    document.querySelectorAll('[data-range]').forEach(b=>{b.classList.toggle('active',b===button);b.setAttribute('aria-pressed',String(b===button));});
    renderChart();
  }));
  document.querySelectorAll('[data-unit]').forEach(button=>button.addEventListener('click',()=>{
    unit = button.dataset.unit;
    document.querySelectorAll('[data-unit]').forEach(b=>{b.classList.toggle('active',b===button);b.setAttribute('aria-pressed',String(b===button));});
    updateMeta(); renderChart(true);
  }));
  $('theme-toggle').addEventListener('click',()=>{theme=theme==='dark'?'light':'dark';applyTheme();});
  $('reset-zoom').addEventListener('click',()=>{userZoomed = false; renderChart();});
  applyTheme();
  if (typeof echarts === 'undefined') {
    $('notice').hidden=false;$('notice').textContent='The chart could not load. Refresh this page to try again.';return;
  }
  chart = echarts.init($('chart'), null, {renderer:'canvas'}); window.chart = chart;
  chart.on('datazoom', () => {if (!restoringZoom) userZoomed = true; scaleVisibleYAxis();});
  let resizeTimer;
  window.addEventListener('resize',()=>{clearTimeout(resizeTimer);resizeTimer=setTimeout(()=>{chart.resize();if(data)renderChart(true);},150);});
  refresh(); setInterval(refresh, 60000); setInterval(updateMeta, 30000);
})();
