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
    let useful = entries.filter(p => !['Trend lower','Trend upper','Conservative band','Uncertainty buffer','Central trend','Last 8 range'].includes(p.seriesName));
    let x = (useful[0] || entries[0])?.value?.[0];
    if (x == null) return '';
    const pixelX=t=>chart.convertToPixel({xAxisIndex:0},Number(t));
    if(calloutTarget!=null && Math.abs(Number(x)-calloutTarget)<=2*3600000 && Math.abs(pixelX(x)-pixelX(calloutTarget))<=5) {
      x=calloutTarget;
      useful=[{seriesName:'const target 850',value:[x,convert(850),850],color:'#f5a524',data:{eventLabel:'850 TAO · const can register'}}];
    } else if(!useful.length) {
      const future=Number(x)>=ts(data.current.time), samples=future ? data.projection : data.pts;
      const nearest=samples.reduce((best,p)=>!best || Math.abs(ts(p[0])-x)<Math.abs(ts(best[0])-x) ? p : best,null);
      if(nearest && Math.abs(pixelX(x)-pixelX(ts(nearest[0])))<=8) {
        x=ts(nearest[0]);useful=[{seriesName:future ? 'Decay projection' : 'Registration cost',value:[x,convert(nearest[1]),Number(nearest[1])],color:future ? colors().muted : colors().accent}];
      }
    }
    const seenQuotes=new Set();
    useful=useful.sort((a,b)=>Number(b.seriesName==='Now')-Number(a.seriesName==='Now')).filter(p=>{
      const key=Number(p.value?.[2] ?? p.value?.[1]);
      if(seenQuotes.has(key)) return false;
      seenQuotes.add(key);return true;
    }).slice(0,2);
    let html = `<div class="tooltip-title">${escape(date(x, true))} UTC</div>`;
    for (const p of useful) {
      const tao = Number(p.value?.[2] ?? p.value?.[1] / (unit === 'usd' ? rate() : 1));
      if (!Number.isFinite(tao)) continue;
      const inferred = p.seriesName === 'Registration cost' ? (data.synthetic_points || []).find(item => ts(item.time) === Number(p.value?.[0])) : null;
      const label = inferred ? 'Inferred pre-registration cost' : p.data?.eventLabel || p.seriesName;
      html += `<div class="tooltip-row"><span><i class="tooltip-color" style="background:${escape(typeof p.color === 'string' ? p.color : colors().blue)}"></i>${escape(label)}</span><strong>${num(tao, 2)} TAO${usdAvailable() ? ` ≈ $${num(tao * rate())}` : ''}</strong></div>`;
      if (inferred) html += '<div class="tooltip-note">Pre-registration cost is inferred from the post-registration quote.</div>';
    }
    if (data.trend && Number.isFinite(Number(x))) {
      const b=trendBounds(Number(x));
      for (const [label,value] of [['Central estimate',num(b.central)+' TAO'],['Main band',`${num(b.lower)}–${num(b.upper)} TAO`],['Buffer range',`${num(b.bufferLower ?? b.lower)}–${num(b.buffer)} TAO`],['Budget for up to · buffer upper',`${num(b.buffer)} TAO${usdAvailable() ? ` ≈ $${num(b.buffer*rate())}` : ''}`]]) html += `<div class="tooltip-row"><span>${label}</span><strong>${value}</strong></div>`;
    }
    if (useful.some(p => /projection|decay|band entry|target/i.test(p.seriesName + (p.data?.eventLabel || '')))) html += '<div class="tooltip-note">Assumes no new registration and unchanged decay.</div>';
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
    // Labels live in a reserved annotation strip, never on the plotted lines.
    const markerData=(data.markers || []).map(m=>({value:[ts(m.time),convert(m.price),Number(m.price)],eventLabel:m.label,label:{show:false}}));
    // 9 Oct 2026 (Florian): const wrote "We can register at 850" -> mark where the decay projection reaches 850 TAO.
    const CONST_TARGET = 850;
    let constTarget = null;
    if (Number(data.current.price) <= CONST_TARGET) constTarget = ts(data.current.time);
    else for (let i = 1; i < data.projection.length; i++) {
      const [t0, p0] = [ts(data.projection[i-1][0]), Number(data.projection[i-1][1])], [t1, p1] = [ts(data.projection[i][0]), Number(data.projection[i][1])];
      if (p0 > CONST_TARGET && p1 <= CONST_TARGET) { constTarget = t0 + (t1 - t0) * (p0 - CONST_TARGET) / (p0 - p1); break; }
    }
    const constSeries = constTarget == null ? [] : [{name:'const target 850',type:'scatter',z:7,symbolSize:mobile ? 11 : 13,
      itemStyle:{color:'#f5a524',borderColor:c.panel,borderWidth:2},
      label:{show:false},
      data:[{value:[constTarget,convert(CONST_TARGET),CONST_TARGET],eventLabel:'850 TAO: const can register',source:'const: "We can register at 850" (9 Oct 2026). Time = when the decay projection reaches 850 TAO, if no other subnet registers first.'}]}];
    calloutTarget = constTarget;
    const series = [ribbon('Conservative band',1,2,theme==='dark' ? '#68a9fb50' : '#357fd74d'),
      ribbon('Uncertainty buffer',5,3,theme==='dark' ? '#a7d9ff38' : '#75bce645'),
      {name:'Central trend',type:'line',data:trendPts.map(p=>[p[0],convert(p[4])]),symbol:'none',silent:true,lineStyle:{color:c.blue,width:1,type:'dotted',opacity:.65},z:2},
      {name:'Trend lower',type:'line',data:trendPts.map(p=>[p[0],convert(p[1])]),symbol:'none',silent:true,lineStyle:{color:c.blue,width:1,opacity:.45},z:1},
      {name:'Trend upper',type:'line',data:trendPts.map(p=>[p[0],convert(p[2])]),symbol:'none',silent:true,lineStyle:{color:c.blue,width:1,opacity:.45},z:1},
      {name:'Registration cost',type:'line',data:points,symbol:'none',lineStyle:{color:c.accent,width:2.3},itemStyle:{color:c.accent},z:3},
      {name:'Registrations',type:'scatter',data:data.registrations.map(r=>({value:[ts(r.time),convert(r.price),Number(r.price)],eventLabel:`Registration · ${r.inferred ? 'estimated' : 'observed'} price paid`,source:r.source})),symbolSize:mobile ? 7 : 8,itemStyle:{color:c.red,borderColor:c.panel,borderWidth:1.5},z:5},
      {name:'Decay projection',type:'line',data:projection,symbol:'none',lineStyle:{color:c.muted,width:1.7,type:'dashed'},itemStyle:{color:c.muted},z:3},
      {name:'Dated projection markers',type:'scatter',labelLayout:{hideOverlap:true},data:markerData,symbolSize:5,itemStyle:{color:c.muted},z:4},
      ...constSeries,
      {name:'Now',type:'scatter',labelLayout:{hideOverlap:true},data:[{value:[ts(data.current.time),convert(data.current.price),Number(data.current.price)],eventLabel:'Current chain cost',source:data.current.source}],symbolSize:9,itemStyle:{color:c.accent,borderColor:c.panel,borderWidth:2},label:{show:false},z:6}
    ];
    chart.setOption({animation:false,backgroundColor:'transparent',textStyle:{fontFamily:'Inter, system-ui, sans-serif',color:c.muted},grid:{left:mobile ? 58 : 77,right:mobile ? 24 : 40,top:mobile ? 194 : 124,bottom:87},legend:{data:['Registration cost','Registrations','Conservative band','Uncertainty buffer','Decay projection'],top:16,left:mobile ? 16 : 27,textStyle:{color:c.muted,fontSize:mobile ? 9 : 10},itemWidth:mobile ? 13 : 18,itemHeight:7,itemGap:mobile ? 12 : 22,selectedMode:true},tooltip:{trigger:'axis',confine:false,appendTo:()=>$('chart').parentElement,position:()=>[16,chart.getHeight()+8],backgroundColor:c.panel,borderColor:c.border,textStyle:{color:c.text,fontSize:11},extraCssText:`width:${Math.min(580,chart.getWidth()-32)}px;white-space:normal;box-shadow:none;border-radius:9px;padding:10px;pointer-events:none;`,axisPointer:{type:'line',lineStyle:{color:c.dim,type:'dashed'}},formatter:tooltip},xAxis:{type:'time',min:minTime,max:bounds.end,axisLine:{lineStyle:{color:c.border}},axisTick:{show:false},axisLabel:{color:c.dim,fontSize:10,hideOverlap:true,formatter:v=>date(v)},splitLine:{show:false}},yAxis:{type:'value',min:0,name:unit === 'tao' ? 'TAO' : 'USD · latest rate',nameTextStyle:{color:c.dim,fontSize:9,align:'left'},nameGap:20,axisLabel:{color:c.dim,fontSize:10,formatter:v=>unit === 'usd' ? (v>=1000000 ? `$${num(v/1000000,1)}m` : `$${num(v/1000,0)}k`) : num(v)},axisLine:{show:false},axisTick:{show:false},splitLine:{lineStyle:{color:c.grid,type:'dashed',opacity:.65}}},dataZoom:[{type:'inside',startValue:bounds.start,endValue:bounds.visibleEnd,filterMode:'none',zoomOnMouseWheel:true,moveOnMouseWheel:false,preventDefaultMouseMove:true},{type:'slider',startValue:bounds.start,endValue:bounds.visibleEnd,filterMode:'none',bottom:18,height:23,left:mobile ? 58 : 77,right:mobile ? 24 : 40,borderColor:c.border,backgroundColor:'transparent',fillerColor:theme === 'dark' ? '#87beff0c' : '#226bc00c',dataBackground:{lineStyle:{color:c.dim,opacity:.5},areaStyle:{color:c.dim,opacity:.08}},selectedDataBackground:{lineStyle:{color:c.accent,opacity:.7},areaStyle:{color:c.accent,opacity:.12}},handleStyle:{color:c.panel,borderColor:c.dim},textStyle:{color:c.muted,fontSize:9},labelFormatter:v=>date(v)}],series}, {notMerge:true});
    if (oldZoom?.[0] && Number.isFinite(Number(oldZoom[0].startValue))) {restoringZoom = true; chart.dispatchAction({type:'dataZoom',startValue:Number(oldZoom[0].startValue),endValue:Number(oldZoom[0].endValue)}); restoringZoom = false;}
    scaleVisibleYAxis();
    layoutCallouts();
    $('chart-empty').hidden = true;
  }
  let calloutTarget = null;
  function layoutCallouts() {
    if (!chart || !data) return;
    const mobile=innerWidth<620, c=colors(), grid=chart.getModel().getComponent('grid').coordinateSystem.getRect();
    const candidates=[];
    if(calloutTarget!=null) candidates.push({time:calloutTarget,price:850,text:`850 TAO · const can register\n${date(calloutTarget,true)} UTC`,color:'#f5a524',priority:0});
    for(const m of data.markers || []) {
      const priority=m.edge==='buffer upper edge' ? 1 : m.edge ? 2 : 3;
      if(priority===3 && (mobile || new Date(ts(m.time)).getUTCDate()%2 || /minimum/i.test(m.label))) continue;
      candidates.push({time:ts(m.time),price:Number(m.price),text:priority===1 ? `Safe · buffer upper edge\n${date(m.time,true)} UTC` : priority===2 ? `Main fan entry\n${date(m.time,true)} UTC` : date(m.time),color:c.muted,priority});
    }
    candidates.sort((a,b)=>a.priority-b.priority);
    const occupied=[],seenDates=new Set(),graphics=[], width=chart.getWidth();
    let row=0;
    for(const item of candidates) {
      const point=chart.convertToPixel({xAxisIndex:0,yAxisIndex:0},[item.time,convert(item.price)]);
      if(!point || point[0]<grid.x || point[0]>grid.x+grid.width || point[1]<grid.y || point[1]>grid.y+grid.height) continue;
      if(item.priority===3 && seenDates.has(date(item.time))) continue;
      const w=item.priority===0 ? 210 : item.priority<3 ? 182 : 52, h=item.priority<3 ? 34 : 20;
      let x,y;
      if(mobile) {
        if(item.priority===3 || row>=3) continue;
        x=16;y=65+row++*40;
      } else {
        y=60;
        const preferred=Math.max(16,Math.min(width-w-16,point[0]-w/2));
        const slots=[preferred,16,...occupied.map(r=>r.x+r.w+12),...occupied.map(r=>r.x-w-12)].filter(v=>v>=16 && v+w<=width-16).sort((a,b)=>Math.abs(a-preferred)-Math.abs(b-preferred));
        x=slots.find(v=>occupied.every(r=>v+w+10<=r.x || v>=r.x+r.w+10));
        if(x===undefined || (item.priority===3 && Math.abs(x-preferred)>70)) continue;
      }
      occupied.push({x,y,w,h});seenDates.add(date(item.time));
      const anchor=Math.max(x+8,Math.min(x+w-8,point[0]));
      graphics.push({id:`callout-line-${graphics.length}`,type:'polyline',silent:true,z:8,shape:{points:[[anchor,y+h],[anchor,grid.y-9],[point[0],point[1]]]},style:{stroke:item.color,lineWidth:1,opacity:.45,lineDash:[3,3]}});
      graphics.push({id:`callout-box-${graphics.length}`,type:'rect',silent:true,z:9,shape:{x,y,width:w,height:h,r:5},style:{fill:c.panel,stroke:c.border,lineWidth:1}});
      graphics.push({id:`callout-text-${graphics.length}`,type:'text',silent:true,z:10,style:{x:x+8,y:y+5,text:item.text,fill:item.color,font:`${item.priority===0 ? '600' : '400'} 10px system-ui, sans-serif`,lineHeight:13}});
    }
    chart.setOption({graphic:graphics},{replaceMerge:['graphic']});
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
  chart.on('datazoom', () => {if (!restoringZoom) userZoomed = true; scaleVisibleYAxis(); layoutCallouts();});
  let resizeTimer;
  window.addEventListener('resize',()=>{clearTimeout(resizeTimer);resizeTimer=setTimeout(()=>{chart.resize();if(data)renderChart(true);},150);});
  refresh(); setInterval(refresh, 60000); setInterval(updateMeta, 30000);
})();
