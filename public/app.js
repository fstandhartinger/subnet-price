'use strict';
(() => {
  const DAY = 86400000;
  const $ = id => document.getElementById(id);
  let data = null, unit = 'tao', range = '30', chart = null, loading = false, fetchError = '';
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
    const entry = (data.markers || []).find(m => /trend/i.test(m.label) && ts(m.time) >= ts(current.time));
    $('crossing-value').textContent = entry ? (/Already/.test(entry.label) ? 'Already inside' : date(entry.time)) : !data.projection.length ? 'Unavailable' : 'No crossing';
    $('crossing-detail').textContent = entry ? (/Already/.test(entry.label) ? 'Current quote is already inside the trend band' : `${date(entry.time, true)} UTC · if decay continues`) : !data.projection.length ? 'Projection is currently unavailable' : 'No future trend-band entry in this projection';
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
    const referenceMarkers = (data.markers || []).filter(m => /trend|range|last/i.test(m.label));
    $('reference-windows').textContent = referenceMarkers.length ? `Conditional reference windows · ${referenceMarkers.map(m => `${/Already/.test(m.label) ? (/trend/i.test(m.label) ? 'Already in trend band' : 'Already in last 8 range') : (/trend/i.test(m.label) ? 'Trend entry' : 'Last 8 range entry')}: ${date(m.time, true)} UTC`).join(' · ')}` : 'Conditional reference windows: currently unavailable.';
    $('floor-explanation').textContent = data.floor != null && Number.isFinite(Number(data.floor)) ? `The dashed path stops at the chain minimum of ${num(data.floor, 2)} TAO (read ${age(data.floor_at)}).` : 'The chain minimum is currently unavailable; any shown endpoint is illustrative.';
    $('source-details').textContent = `Current cost: Finney chain · History & TAO/USD: Taostats · ${data.registrations.length} observed registrations`;
  }
  function viewBounds() {
    const currentTime = ts(data.current.time);
    const first = data.pts.length ? ts(data.pts[0][0]) : currentTime - DAY;
    const end = Math.max(currentTime + DAY, ...data.projection.map(p => ts(p[0])));
    return {start:range === 'all' ? first : Math.max(first, currentTime - Number(range) * DAY), end};
  }
  function tooltip(params) {
    const entries = Array.isArray(params) ? params : [params];
    const useful = entries.filter(p => !['Trend lower','Trend upper','Trend band','Last 8 range'].includes(p.seriesName));
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
    return html;
  }
  function renderChart(preserveZoom = false) {
    if (!chart || !data) return;
    const c = colors(), mobile = innerWidth < 620, bounds = viewBounds();
    const oldZoom = preserveZoom ? chart.getOption()?.dataZoom : null;
    const points = data.pts.map(p => [ts(p[0]), convert(p[1]), Number(p[1])]);
    const projection = data.projection.map(p => [ts(p[0]), convert(p[1]), Number(p[1])]);
    const trend = data.trend, band = data.bands;
    const trendPts = [];
    const minTime = points.length ? points[0][0] : bounds.start;
    if (trend && trend.slope != null && Number.isFinite(Number(trend.slope))) for (let i = 0; i <= 120; i++) {
      const t = minTime + (bounds.end - minTime) * i / 120;
      const center = Number(trend.intercept) + Number(trend.slope) * (t - ts(trend.origin)) / DAY;
      trendPts.push([t, Math.max(0, center + Number(trend.low)), Math.max(0, center + Number(trend.high))]);
    }
    const trendPoly = trendPts.map(p=>[p[0],convert(p[1])]).concat([...trendPts].reverse().map(p=>[p[0],convert(p[2])]));
    const series = [{name:'Trend band',type:'custom',silent:true,z:0,data:trendPoly.length ? [0] : [],renderItem:(params,api)=>({type:'polygon',shape:{points:trendPoly.map(p=>api.coord(p))},style:{fill:theme === 'dark' ? '#68a9fb22' : '#357fd71c'},clipPath:{type:'rect',shape:{x:params.coordSys.x,y:params.coordSys.y,width:params.coordSys.width,height:params.coordSys.height}}})},
      {name:'Trend lower',type:'line',data:trendPts.map(p=>[p[0],convert(p[1])]),symbol:'none',silent:true,lineStyle:{color:c.blue,width:1,opacity:.45},z:1},
      {name:'Trend upper',type:'line',data:trendPts.map(p=>[p[0],convert(p[2])]),symbol:'none',silent:true,lineStyle:{color:c.blue,width:1,opacity:.45},z:1},
      {name:'Registration cost',type:'line',data:points,symbol:'none',lineStyle:{color:c.accent,width:2.3},itemStyle:{color:c.accent},z:3,
        markArea:band && Number.isFinite(Number(band.min)) ? {silent:true,itemStyle:{color:theme === 'dark' ? '#a5afbc15' : '#64748b13'},label:{show:!mobile,position:'insideTopLeft',color:c.dim,fontSize:10,formatter:`Last ${band.n || 8} registration range`},data:[[{yAxis:convert(band.min)},{yAxis:convert(band.max)}]]} : undefined},
      {name:'Registrations',type:'scatter',data:data.registrations.map(r=>({value:[ts(r.time),convert(r.price),Number(r.price)],eventLabel:`Registration · ${r.inferred ? 'estimated' : 'observed'} price paid`,source:r.source})),symbolSize:mobile ? 7 : 8,itemStyle:{color:c.red,borderColor:c.panel,borderWidth:1.5},z:5},
      {name:'Decay projection',type:'line',data:projection,symbol:'none',lineStyle:{color:c.muted,width:1.7,type:'dashed'},itemStyle:{color:c.muted},z:3},
      {name:'Dated projection markers',type:'scatter',labelLayout:{hideOverlap:true},data:(data.markers || []).map(m=>({value:[ts(m.time),convert(m.price),Number(m.price)],eventLabel:m.label,label:{show:!mobile || /trend|range|last/i.test(m.label),formatter:/trend/i.test(m.label) ? `Trend entry\n${date(m.time)}` : /range|last/i.test(m.label) ? `Range entry\n${date(m.time)}` : date(m.time),position:'top',color:c.muted,fontSize:9,distance:10}})),symbolSize:5,itemStyle:{color:c.muted},z:4},
      {name:'Now',type:'scatter',labelLayout:{hideOverlap:true},data:[{value:[ts(data.current.time),convert(data.current.price),Number(data.current.price)],eventLabel:'Current chain cost',source:data.current.source}],symbolSize:9,itemStyle:{color:c.accent,borderColor:c.panel,borderWidth:2},label:{show:true,formatter:mobile ? `Now ≈ ${price(data.current.price)}` : `Now ≈ ${num(data.current.price,2)} TAO${usdAvailable() ? ` (≈ $${num(data.current.price * rate(),0)})` : ' (USD unavailable)'}`,position:'top',distance:13,color:c.accent,fontSize:mobile ? 10 : 11,fontWeight:600},z:6}
    ];
    chart.setOption({animation:false,backgroundColor:'transparent',textStyle:{fontFamily:'Inter, system-ui, sans-serif',color:c.muted},grid:{left:mobile ? 58 : 77,right:mobile ? 24 : 40,top:66,bottom:87},legend:{data:['Registration cost','Registrations','Trend band','Decay projection'],top:16,left:mobile ? 16 : 27,textStyle:{color:c.muted,fontSize:mobile ? 9 : 10},itemWidth:mobile ? 13 : 18,itemHeight:7,itemGap:mobile ? 12 : 22,selectedMode:true},tooltip:{trigger:'axis',confine:true,backgroundColor:c.panel,borderColor:c.border,textStyle:{color:c.text,fontSize:12},extraCssText:'max-width:330px;box-shadow:0 8px 32px #0003;border-radius:9px;padding:14px;',axisPointer:{type:'line',lineStyle:{color:c.dim,type:'dashed'}},formatter:tooltip},xAxis:{type:'time',min:minTime,max:bounds.end,axisLine:{lineStyle:{color:c.border}},axisTick:{show:false},axisLabel:{color:c.dim,fontSize:10,hideOverlap:true,formatter:v=>date(v)},splitLine:{show:false}},yAxis:{type:'value',min:0,name:unit === 'tao' ? 'TAO' : 'USD · latest rate',nameTextStyle:{color:c.dim,fontSize:9,align:'left'},nameGap:20,axisLabel:{color:c.dim,fontSize:10,formatter:v=>unit === 'usd' ? (v>=1000000 ? `$${num(v/1000000,1)}m` : `$${num(v/1000,0)}k`) : num(v)},axisLine:{show:false},axisTick:{show:false},splitLine:{lineStyle:{color:c.grid,type:'dashed',opacity:.65}}},dataZoom:[{type:'inside',startValue:bounds.start,endValue:bounds.end,filterMode:'none',zoomOnMouseWheel:true,moveOnMouseWheel:false,preventDefaultMouseMove:true},{type:'slider',startValue:bounds.start,endValue:bounds.end,filterMode:'none',bottom:18,height:23,left:mobile ? 58 : 77,right:mobile ? 24 : 40,borderColor:c.border,backgroundColor:'transparent',fillerColor:theme === 'dark' ? '#87beff0c' : '#226bc00c',dataBackground:{lineStyle:{color:c.dim,opacity:.5},areaStyle:{color:c.dim,opacity:.08}},selectedDataBackground:{lineStyle:{color:c.accent,opacity:.7},areaStyle:{color:c.accent,opacity:.12}},handleStyle:{color:c.panel,borderColor:c.dim},textStyle:{color:c.muted,fontSize:9},labelFormatter:v=>date(v)}],series}, {notMerge:true});
    if (oldZoom?.[0] && Number.isFinite(oldZoom[0].start)) chart.dispatchAction({type:'dataZoom',start:oldZoom[0].start,end:oldZoom[0].end});
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
    range = button.dataset.range;
    document.querySelectorAll('[data-range]').forEach(b=>{b.classList.toggle('active',b===button);b.setAttribute('aria-pressed',String(b===button));});
    renderChart();
  }));
  document.querySelectorAll('[data-unit]').forEach(button=>button.addEventListener('click',()=>{
    unit = button.dataset.unit;
    document.querySelectorAll('[data-unit]').forEach(b=>{b.classList.toggle('active',b===button);b.setAttribute('aria-pressed',String(b===button));});
    updateMeta(); renderChart(true);
  }));
  $('theme-toggle').addEventListener('click',()=>{theme=theme==='dark'?'light':'dark';applyTheme();});
  $('reset-zoom').addEventListener('click',()=>renderChart());
  applyTheme();
  if (typeof echarts === 'undefined') {
    $('notice').hidden=false;$('notice').textContent='The chart could not load. Refresh this page to try again.';return;
  }
  chart = echarts.init($('chart'), null, {renderer:'canvas'}); window.chart = chart;
  let resizeTimer;
  window.addEventListener('resize',()=>{clearTimeout(resizeTimer);resizeTimer=setTimeout(()=>{chart.resize();if(data)renderChart(true);},150);});
  refresh(); setInterval(refresh, 60000); setInterval(updateMeta, 30000);
})();
