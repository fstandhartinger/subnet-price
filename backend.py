#!/usr/bin/env python3
"""Public, read-only subnet price service. All credentials remain server-side."""
import datetime as dt
import functools
import http.server
import json
import math
import os
from pathlib import Path
import statistics
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

DAY = 86400000
HISTORY_INTERVAL = 10800
CHAIN_INTERVAL = 300
ENDPOINTS = ('https://entrypoint-finney.opentensor.ai:443', 'https://lite.chain.opentensor.ai:443')


def timestamp(value):
    return int(dt.datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp() * 1000)


def quantile(values, q):
    values = sorted(values)
    pos = (len(values) - 1) * q
    lo = int(pos)
    return values[lo] + (values[min(lo + 1, len(values) - 1)] - values[lo]) * (pos - lo)


def history_analysis(rows):
    clean = {}
    for r in rows:
        try:
            t, p = timestamp(r['timestamp']), int(r['registration_cost']) / 1e9
            if p >= 0 and math.isfinite(p):
                purchase = r.get('is_purchase') is True
                clean[(t, int(r.get('block_number') or 0), p, purchase)] = (p, purchase)
        except (ValueError, KeyError, TypeError):
            continue
    samples = [(key[0], *v) for key, v in sorted(clean.items())]
    events, handled = [], set()
    # Provider flags have included both pre- and post-registration quotes. Detect
    # which side of the jump the flag occupies, rather than calling both prices paid.
    for i, (t, p, purchase) in enumerate(samples):
        if not purchase:
            continue
        jump_here = i > 0 and p > samples[i-1][1] * 1.3
        jump_next = i + 1 < len(samples) and samples[i+1][1] > p * 1.3
        if jump_here:
            events.append({'time': t, 'price': p / 2, 'source': 'Taostats purchase flag; paid price inferred as half post-registration quote', 'inferred': True})
            handled.add(i)
        elif jump_next:
            events.append({'time': t, 'price': p, 'source': 'Taostats purchase flag; observed pre-registration quote', 'inferred': False})
            handled.add(i+1)
        else:
            # Ambiguous flags are retained as provenance, but cannot establish paid price.
            continue
    for i in range(1, len(samples)):
        if i not in handled and samples[i][1] > samples[i-1][1] * 1.3:
            events.append({'time': samples[i][0], 'price': samples[i][1] / 2, 'source': 'Inferred jump; approximate paid price = half post-registration quote', 'inferred': True})
    events.sort(key=lambda e: e['time'])
    # Estimate the most recent decay segment only; chain/history gaps never create events.
    last_jump = max((i for i in range(1, len(samples)) if samples[i][1] > samples[i-1][1]*1.3), default=0)
    seg = samples[last_jump:]
    slopes = [(a[1]-b[1])/((b[0]-a[0])/DAY) for a,b in zip(seg, seg[1:]) if b[0]>a[0] and a[1]>=b[1]]
    rate = statistics.median(slopes) if slopes else 0
    points = [[t,p] for t,p,_ in samples]
    for event in events:
        if event['inferred']:
            points.append([event['time']-1,event['price']])
    return sorted(points), events, rate


def trend_fit(events):
    recent = events[-8:]
    if len(recent) < 3:
        return None
    origin = recent[0]['time']
    xy = [((r['time']-origin)/DAY, r['price']) for r in recent]
    slopes = [(b[1]-a[1])/(b[0]-a[0]) for i,a in enumerate(xy) for b in xy[i+1:] if b[0]>a[0]]
    if not slopes:
        return None
    slope = statistics.median(slopes)
    intercept = statistics.median([y-slope*x for x,y in xy])
    residuals = [y-(intercept+slope*x) for x,y in xy]
    return dict(origin=origin, slope=slope, intercept=intercept, low=quantile(residuals,.1), high=quantile(residuals,.9), n=len(recent))


def project(current, rate, bands, trend):
    if not current or rate <= 0:
        return [], []
    now, price = current['time'], current['price']
    end = now + min(price/rate, 60)*DAY
    def cost(t): return max(0, price-rate*(t-now)/DAY)
    markers = []
    day = (now // DAY + 1)*DAY
    while day < end:
        markers.append(dict(time=day,price=cost(day),label='Daily decay projection'))
        day += DAY
    # Solve first entry to moving upper/lower boundaries, checking both edges;
    # linear inequalities avoid missed narrow bands from coarse daily sampling.
    def entry(lower, upper, slope, label):
        lo, hi = 0., (end-now)/DAY
        for a,b in [(price-upper,-rate-slope),(lower-price,slope+rate)]:
            if abs(b)<1e-12:
                if a>0: return
            elif b>0: hi=min(hi,-a/b)
            else: lo=max(lo,-a/b)
        if lo <= hi and hi >= 0 and lo <= (end-now)/DAY:
            t=int(now+max(0,lo)*DAY)
            markers.append(dict(time=t,price=cost(t),label=label))
    if bands: entry(bands['min'],bands['max'],0,'Enters last 8 registration range')
    if trend:
        center=trend['intercept']+trend['slope']*(now-trend['origin'])/DAY
        entry(center+trend['low'],center+trend['high'],trend['slope'],'Enters trend band')
    projection=[[now,price]]+[[m['time'],m['price']] for m in markers]+[[int(end),cost(end)]]
    return sorted(projection), sorted(markers,key=lambda m:m['time'])


class RateLimited(Exception):
    def __init__(self, delay=300): self.delay=delay


def request_json(url, key=None, body=None):
    headers={'Accept':'application/json','User-Agent':'subnet-price/1.0'}
    if key: headers['Authorization']=key
    if body is not None: headers['Content-Type']='application/json'
    req=urllib.request.Request(url,headers=headers,data=json.dumps(body).encode() if body is not None else None)
    try:
        with urllib.request.urlopen(req,timeout=15) as r:
            raw=r.read(4*1024*1024+1)
            if len(raw)>4*1024*1024: raise ValueError('Response too large')
            return json.loads(raw)
    except urllib.error.HTTPError as e:
        if e.code==429:
            retry=e.headers.get('Retry-After','300')
            try: delay=float(retry)
            except ValueError: delay=300
            raise RateLimited(min(10800,max(60,delay))) from None
        raise


def fetch_history(key, now):
    rows=[]
    since=now-130*DAY
    for page in range(1,26):
        data=request_json(f'https://api.taostats.io/api/subnet/registration_cost/history/v1?limit=200&page={page}&order=timestamp_desc',key)
        batch=data.get('data',[])
        rows.extend(batch)
        if not batch or not data.get('pagination',{}).get('next_page') or timestamp(batch[-1]['timestamp'])<since:
            return [r for r in rows if timestamp(r['timestamp'])>=since]
        time.sleep(1.2)
    raise ValueError('History exceeded bounded pagination; retaining previous cache')


def fetch_chain():
    for endpoint in ENDPOINTS:
        try:
            result=request_json(endpoint,body={'jsonrpc':'2.0','id':1,'method':'state_call','params':['SubnetRegistrationRuntimeApi_get_network_registration_cost','0x']})['result']
            raw=bytes.fromhex(result.removeprefix('0x'))
            if len(raw) not in (8,16): raise ValueError('Unexpected SCALE cost length')
            price=int.from_bytes(raw,'little')/1e9
            if not math.isfinite(price) or price<0: raise ValueError('Invalid chain price')
            return price
        except (OSError,ValueError,KeyError,TypeError):
            continue
    raise ValueError('Chain endpoints unavailable')


class Store:
    def __init__(self, cache_dir=None):
        self.lock=threading.Lock()
        self.cache=Path(cache_dir or os.getenv('CACHE_DIR','/tmp/subnet-price'))/'cache.json'
        self.state=dict(rows=[],current=None,history_at=None,usd=None,usd_at=None)
        self.errors={}
        self.due={'chain':0,'history':0,'usd':0}
        self.failures={k:0 for k in self.due}
        self.chain_samples=[]
        self.last_history_attempt=0
        try:
            cached=json.loads(self.cache.read_text())
            if isinstance(cached.get('rows'),list) and len(cached['rows'])<=5000:
                self.state.update({k:cached[k] for k in self.state if k in cached})
        except (OSError,ValueError,TypeError): pass

    def refresh(self, kind):
        now=int(time.time()*1000)
        try:
            if kind=='chain': update={'current':dict(time=now,price=fetch_chain(),source='Finney chain runtime API')}
            else:
                key=os.getenv('TAOSTATS_API') or os.getenv('TAOSTATS_API_KEY')
                if not key: raise ValueError('Taostats server credential unavailable')
                if kind=='history':
                    self.last_history_attempt=time.time()
                    update=dict(rows=fetch_history(key,now),history_at=now)
                else:
                    row=request_json('https://api.taostats.io/api/price/latest/v1?asset=tao',key)['data'][0]
                    value=float(row['price'])
                    if not math.isfinite(value) or value<=0: raise ValueError('Invalid USD rate')
                    update=dict(usd=value,usd_at=timestamp(row['timestamp']) if row.get('timestamp') else now)
            with self.lock:
                if kind=='chain':
                    quote=update['current']
                    if self.chain_samples and quote['price']>self.chain_samples[-1]['price']*1.01:
                        self.chain_samples=[]
                    if not self.chain_samples or quote['time']-self.chain_samples[-1]['time']>=60000:
                        self.chain_samples=(self.chain_samples+[quote])[-12:]
                    raw_pts,_,_=history_analysis(self.state['rows'])
                    if raw_pts and quote['price']>raw_pts[-1][1]*1.3 and time.time()-self.last_history_attempt>60:
                        self.due['history']=min(self.due['history'],time.time())
                self.state.update(update)
                self.errors.pop(kind,None)
                self.failures[kind]=0
                self.due[kind]=time.time()+(CHAIN_INTERVAL if kind=='chain' else HISTORY_INTERVAL if kind=='history' else 900)
                snapshot=dict(self.state)
            self.cache.parent.mkdir(parents=True,exist_ok=True)
            tmp=self.cache.with_suffix('.tmp')
            tmp.write_text(json.dumps(snapshot,allow_nan=False)); tmp.replace(self.cache)
        except Exception as e:
            with self.lock:
                self.failures[kind]+=1
                self.due[kind]=time.time()+(e.delay if isinstance(e,RateLimited) else min(3600,60*2**min(self.failures[kind],6)))
                self.errors[kind]=f'{kind.capitalize()} refresh unavailable; retaining last good data.'

    def loop(self):
        while True:
            for kind in self.due:
                if time.time()>=self.due[kind]: self.refresh(kind)
            time.sleep(5)

    def data(self):
        with self.lock:
            state=dict(self.state); warnings=list(self.errors.values()); chain_samples=list(self.chain_samples)
        now=int(time.time()*1000)
        pts,events,rate=history_analysis(state['rows'])
        current=state['current']
        if len(chain_samples)>=2:
            first,last=chain_samples[0],chain_samples[-1]
            if last['time']-first['time']>=60000 and last['price']<first['price']:
                rate=(first['price']-last['price'])/((last['time']-first['time'])/DAY)
        if current:
            age=now-current['time']
            if age>900000: warnings.append('Current chain quote is stale; see its observation time.')
        else: warnings.append('Current chain price unavailable.')
        if not pts: warnings.append('Registration history unavailable.')
        elif now-(state['history_at'] or 0)>6*3600000: warnings.append('History cache is stale.')
        if state['usd'] is None: warnings.append('TAO/USD conversion unavailable.')
        elif now-(state['usd_at'] or 0)>3600000: warnings.append('TAO/USD conversion is stale.')
        recent=events[-8:]
        bands=dict(min=min(r['price'] for r in recent),max=max(r['price'] for r in recent),n=len(recent)) if recent else None
        trend=trend_fit(events)
        projection,markers=project(current,rate,bands,trend) if current and now-current['time']<=900000 else ([],[])
        if current and pts and current['price']>pts[-1][1]*1.3:
            warnings.append('Chain quote has risen since cached history; recent registrations may not yet be indexed. Projection paused.')
            projection,markers=[],[]
        return dict(pts=pts,registrations=events,rate=rate,usd=state['usd'],built=now,current_at=current['time'] if current else None,history_at=state['history_at'],usd_at=state['usd_at'],current=current,trend=trend,bands=bands,projection=projection,markers=markers,warnings=warnings,synthetic_points=[dict(time=e['time']-1,source='Inferred pre-jump quote for sawtooth display') for e in events if e['inferred']])


class Server(http.server.ThreadingHTTPServer):
    daemon_threads=True
    def __init__(self,*args,**kwargs):
        self.slots=threading.BoundedSemaphore(32)
        super().__init__(*args,**kwargs)
    def process_request(self,request,address):
        if not self.slots.acquire(False): request.close(); return
        try: super().process_request(request,address)
        except Exception: self.slots.release(); raise
    def process_request_thread(self,request,address):
        try: super().process_request_thread(request,address)
        finally: self.slots.release()


class Handler(http.server.SimpleHTTPRequestHandler):
    def setup(self):
        super().setup(); self.connection.settimeout(10)
    def do_GET(self):
        path=urllib.parse.urlsplit(self.path).path
        if path in ('/api/data','/healthz'):
            data=self.server.store.data()
            ready=bool(data['pts'] and data['current'] and data['built']-data['current_at']<3600000)
            payload=data if path=='/api/data' else dict(status='ok' if ready else 'degraded',ready=ready)
            body=json.dumps(payload,allow_nan=False,separators=(',',':')).encode()
            self.send_response(200 if path=='/api/data' or ready else 503)
            self.send_header('Content-Type','application/json; charset=utf-8')
            self.send_header('Cache-Control','no-store'); self.send_header('Content-Length',str(len(body))); self.end_headers(); self.wfile.write(body)
        else: super().do_GET()
    def list_directory(self,path):
        self.send_error(404); return None
    def translate_path(self,path):
        result=super().translate_path(path)
        root=Path(self.directory).resolve()
        if not Path(result).resolve().is_relative_to(root): return str(root/'__missing__')
        return result
    def log_message(self,format,*args): pass


def main():
    store=Store()
    threading.Thread(target=store.loop,daemon=True).start()
    public=Path(__file__).parent/'public'
    server=Server(('0.0.0.0',int(os.getenv('PORT','8000'))),functools.partial(Handler,directory=str(public)))
    server.store=store
    server.serve_forever()


if __name__=='__main__': main()
