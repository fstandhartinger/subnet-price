import functools
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch
import urllib.request
import urllib.error
import backend as b


def reg(day,paid,block=None):
    return dict(block=block or int(day*7200),time=int(day*86400000),paid_rao=int(paid*1e9))


class FakeChain:
    """Archive state: registrations at blocks; storage reads at a hash = block number."""
    def __init__(self, regs, head):
        self.regs=sorted(regs,key=lambda r:r['block']); self.head=head; self.calls=0
    def __call__(self, method, params, endpoints=None):
        self.calls+=1
        if method=='chain_getFinalizedHead': return self.head
        if method=='chain_getBlockHash': return params[0]
        if method=='state_queryStorageAt':
            keys,block=params
            last=[r for r in self.regs if r['block']<=block]
            values={b.TIMESTAMP_KEY:next((r['time'] for r in self.regs if r['block']==block),None)}
            if last: values.update({b.LAST_REG_KEY:last[-1]['block'],b.LAST_LOCK_KEY:last[-1]['paid_rao']})
            enc=lambda v: None if v is None else '0x'+v.to_bytes(8,'little').hex()
            return [dict(block=block,changes=[[k,enc(values.get(k))] for k in keys])]
        raise AssertionError(method)


class MathTests(unittest.TestCase):
    def test_chain_sawtooth_paid_prices_and_current_decay(self):
        regs=[reg(1,500),reg(3,600),reg(5,700)]
        current=dict(time=int(5.5*b.DAY),price=1225,source='chain')
        pts,events,rate=b.chain_analysis(regs,current,1)
        self.assertEqual([e['price'] for e in events],[500,600,700])
        self.assertTrue(all(not e['inferred'] and 'block' in e['source'] for e in events))
        self.assertAlmostEqual(rate,350,places=6)  # 1400 -> 1225 in half a day
        self.assertIn([regs[1]['time']-1,600],pts)  # pre-jump point = exact paid price
        self.assertIn([regs[0]['time'],1000],pts)  # post-registration quote = 2 x paid
        self.assertEqual(pts[-1],[current['time'],1225])
        self.assertEqual(pts,sorted(pts))

    def test_floor_segment_uses_decay_period(self):
        regs=[reg(0,100),reg(2,150),reg(10,1)]
        pts,_,_=b.chain_analysis(regs,None,1)
        segment=[p for p in pts if regs[1]['time']<=p[0]<regs[2]['time']-1]
        self.assertEqual(min(p[1] for p in segment),1)
        self.assertGreater(segment[0][1],segment[1][1])

    def test_walk_reads_chain_and_stops_at_known(self):
        now=200*b.DAY
        regs=[reg(d,100+d) for d in (40,60,80,120,150,190)]
        chain=FakeChain(regs,int(199*7200))
        with patch.object(b,'chain_rpc',chain):
            found=b.fetch_registrations([],now)
            self.assertEqual([r['block'] for r in found],[r['block'] for r in regs[1:]])  # window + one before
            chain.calls=0
            again=b.fetch_registrations(found,now)
        self.assertEqual(again,found); self.assertLessEqual(chain.calls,2)
        chain.regs.append(reg(195,300)); chain.head=int(196*7200)
        with patch.object(b,'chain_rpc',chain):
            self.assertEqual(b.fetch_registrations(found,now)[-1]['paid_rao'],300*10**9)

    def test_archive_budget_error_backs_off_without_retry_storm(self):
        reply={'jsonrpc':'2.0','id':1,'error':{'code':-32004,'message':'Historical work rate limit exceeded'}}
        with patch.object(b,'request_json',return_value=reply) as call, patch.object(b.time,'sleep'):
            with self.assertRaises(b.RateLimited): b.chain_rpc('state_queryStorageAt',[[],'0x0'])
        self.assertEqual(call.call_count,1)

    def test_usd_exhausted_credits_fall_back_loudly(self):
        def fake(url,key=None,body=None):
            if 'taostats' in url: raise b.CreditsExhausted('Taostats credits exhausted')
            return {'bittensor':{'usd':321.5,'last_updated_at':1000}}
        with patch.object(b,'request_json',side_effect=fake):
            value,at,source=b.fetch_usd('key')
        self.assertEqual((value,at),(321.5,1000000)); self.assertIn('credits exhausted',source)

    def test_robust_trend_ignores_outlier(self):
        events=[dict(time=i*b.DAY,price=100+10*i+(500 if i==4 else 0)) for i in range(8)]
        trend=b.trend_fit(events)
        self.assertEqual(trend['slope'],10)
        self.assertAlmostEqual(trend['intercept'],100)
        for event in events:
            bounds=b.trend_bounds(trend,event['time'])
            self.assertLessEqual(bounds['lower'],event['price'])
            self.assertGreaterEqual(bounds['upper'],event['price'])

    def test_crossings_include_first_moving_band_entry(self):
        current=dict(time=int(.25*b.DAY),price=100)
        trend=dict(origin=current['time'],slope=5,intercept=50,low=-10,high=10)
        projection,markers=b.project(current,10,dict(min=20,max=30),trend)
        crossing=next(m for m in markers if 'trend' in m['label'])
        self.assertAlmostEqual((crossing['time']-current['time'])/b.DAY,40/15,places=7)
        self.assertAlmostEqual(next(m for m in markers if 'last' in m['label'])['price'],30)
        self.assertEqual(projection[-1][1],0)

    def test_fan_contains_all_recent_dots_and_widens_only_after_last_paid(self):
        for prices in ([100,120,90,140,110,180,130,220], [800,700,600,500,400,300,200,100]):
            events=[dict(time=i*b.DAY,price=p) for i,p in enumerate(prices)]
            trend=b.trend_fit(events)
            for event in events:
                bounds=b.trend_bounds(trend,event['time'])
                self.assertLess(bounds['lower'],event['price'])
                self.assertGreater(bounds['upper'],event['price'])
            at=b.trend_bounds(trend,7*b.DAY)
            future=b.trend_bounds(trend,7.25*b.DAY)
            later=b.trend_bounds(trend,7.5*b.DAY)
            self.assertGreater(future['upper']-future['central'],at['upper']-at['central'])
            self.assertGreater(later['upper']-later['central'],future['upper']-future['central'])
            self.assertGreaterEqual(future['buffer'],future['upper'])
            self.assertLessEqual(future['buffer_lower'],future['lower'])

    def test_curved_crossings_match_edges_and_outer_buffer_is_earlier(self):
        for slope in (10,-10,-100):
            trend=dict(origin=0,last_paid=0,slope=slope,intercept=600,low=-100,high=100,
                       fan_curvature=2,buffer_multiplier=1.7,buffer_extra=80,policy='fan')
            _,markers=b.project(dict(time=0,price=1200),60,None,trend)
            safe=next(m for m in markers if m.get('edge')=='buffer upper edge')
            main=next(m for m in markers if m.get('edge')=='conservative upper edge')
            self.assertLess(safe['time'],main['time'])
            self.assertAlmostEqual(safe['price'],b.trend_bounds(trend,safe['time'])['buffer'],places=5)
            self.assertAlmostEqual(main['price'],b.trend_bounds(trend,main['time'])['upper'],places=5)
            self.assertFalse(any('last 8' in m['label'] for m in markers))
        _,markers=b.project(dict(time=0,price=650),60,None,trend)
        self.assertEqual(next(m for m in markers if m.get('edge')=='buffer upper edge')['time'],0)

    def test_safe_entry_is_upper_edge_and_earlier_than_central_entry(self):
        trend=dict(origin=0,slope=5,intercept=50,low=0,high=20,policy='conservative')
        _,markers=b.project(dict(time=0,price=100),10,None,trend)
        safe=next(m for m in markers if 'safe estimate' in m['label'])
        self.assertAlmostEqual(safe['time']/b.DAY,2)
        self.assertLess(safe['time']/b.DAY,(100-50)/15)
        self.assertEqual(safe['price'],80)

    def test_safe_threshold_already_reached_including_below_band(self):
        trend=dict(origin=0,slope=5,intercept=50,low=0,high=20,policy='conservative')
        for price in (60,40):
            _,markers=b.project(dict(time=0,price=price),10,None,trend)
            safe=next(m for m in markers if 'Safe estimate reached' in m['label'])
            self.assertEqual(safe['time'],0)

    def test_visible_minimum_width_and_buffer_despite_exact_fit(self):
        trend=b.trend_fit([dict(time=i*b.DAY,price=600+10*i) for i in range(8)])
        bounds=b.trend_bounds(trend,8*b.DAY)
        self.assertGreaterEqual(bounds['upper']-bounds['lower'],.3*bounds['lower']-1e-8)
        self.assertGreaterEqual(bounds['buffer']-bounds['upper'],.10*600-1e-8)
        self.assertLess(bounds['lower'],bounds['central'])
        self.assertGreater(bounds['upper'],bounds['central'])

    def test_buffer_crossing_precedes_conservative_and_matches_price(self):
        for slope in (10,-10):
            trend=dict(origin=0,slope=slope,intercept=600,central_intercept=590,low=0,high=10,
                       minimum_width_fraction=.3,buffer_extra=80,minimum_buffer_fraction=.15,policy='conservative')
            _,markers=b.project(dict(time=0,price=1200),60,None,trend)
            buffered=next(m for m in markers if m.get('edge')=='buffer upper edge')
            conservative=next(m for m in markers if m.get('edge')=='conservative upper edge')
            self.assertLess(buffered['time'],conservative['time'])
            self.assertAlmostEqual(buffered['price'],b.trend_bounds(trend,buffered['time'])['buffer'],places=5)
            self.assertAlmostEqual(conservative['price'],b.trend_bounds(trend,conservative['time'])['upper'],places=5)

    def test_projection_stops_at_actual_chain_floor(self):
        points,markers=b.project(dict(time=0,price=101),10,None,None,floor=1)
        self.assertEqual(points[-1],[10*b.DAY,1])
        self.assertEqual(markers[-1]['label'],'Chain minimum reached')
        self.assertTrue(all(p[1]>=1 for p in points))

    def test_floor_and_already_inside_markers(self):
        self.assertEqual(b.project(dict(time=0,price=1),10,None,None,floor=1),([],[]))
        _,markers=b.project(dict(time=0,price=50),10,dict(min=40,max=60),dict(origin=0,slope=0,intercept=50,low=-10,high=10),floor=1)
        self.assertTrue(any(m['label']=='Already in trend band' for m in markers))
        self.assertFalse(any(m['label'].startswith('Enters') for m in markers))

    def test_no_crossing_for_diverging_band_and_bounded_projection(self):
        current=dict(time=0,price=10000)
        projection,markers=b.project(current,1,None,dict(origin=0,slope=-2,intercept=50,low=-10,high=10))
        self.assertFalse(any('trend' in m['label'] for m in markers))
        self.assertEqual(projection[-1][0],60*b.DAY)


class StoreTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(); self.store=b.Store(self.tmp.name)
        self.floor_patch=patch.object(b,'fetch_chain_floor',return_value=1); self.floor_patch.start()
    def tearDown(self): self.floor_patch.stop(); self.tmp.cleanup()
    def test_current_chain_gap_never_creates_registration(self):
        now=int(b.time.time()*1000)
        self.store.state.update(regs=[reg(now/b.DAY-2,600),reg(now/b.DAY-1,300)],history_at=now,current=dict(time=now,price=1000,source='chain'))
        data=self.store.data()
        self.assertEqual(len(data['registrations']),2)
        self.assertEqual(data['projection'],[])
        self.assertTrue(any('being read from the chain' in w for w in data['warnings']))
    def test_last_good_preserved_on_rate_limit(self):
        self.store.state['regs']=[reg(1,100)]
        with patch.object(b,'fetch_registrations',side_effect=b.RateLimited(700)):
            self.store.refresh('history')
        self.assertEqual(self.store.state['regs'],[reg(1,100)])
        self.assertGreater(self.store.due['history'],b.time.time()+695)
        self.assertIn('history',self.store.errors)
    def test_consecutive_chain_quotes_update_decay_and_jump_requests_history(self):
        now=int(b.time.time()*1000)
        self.store.state.update(regs=[reg(now/b.DAY-2,500)],history_at=now)
        self.store.chain_samples=[dict(time=now-b.DAY,price=600,source='chain')]
        with patch.object(b,'fetch_chain',return_value=550): self.store.refresh('chain')
        self.assertAlmostEqual(self.store.data()['rate'],225,places=0)  # 1000 -> 550 over two days
        self.store.due['history']=b.time.time()+10000
        with patch.object(b,'fetch_chain',return_value=1200): self.store.refresh('chain')
        self.assertEqual(len(self.store.chain_samples),1)
        self.assertLessEqual(self.store.due['history'],b.time.time())
        self.assertEqual(self.store.data()['projection'],[])

    def test_floor_rate_limit_keeps_fresh_current_and_backoff(self):
        with patch.object(b,'fetch_chain',return_value=400), patch.object(b,'fetch_chain_floor',side_effect=b.RateLimited(800)):
            self.store.refresh('chain')
        self.assertEqual(self.store.state['current']['price'],400)
        self.assertIsNone(self.store.state['floor'])
        self.assertGreater(self.store.due['chain'],b.time.time()+795)
        self.assertEqual(self.store.data()['projection'],[])

    def test_history_fetch_does_not_block_chain_and_cache_keeps_both(self):
        entered=threading.Event(); release=threading.Event()
        def history(*args):
            entered.set(); release.wait(2); return [reg(1,500)]
        with patch.object(b,'fetch_registrations',side_effect=history), patch.object(b,'fetch_chain',return_value=450):
            worker=threading.Thread(target=self.store.refresh,args=('history',)); worker.start()
            self.assertTrue(entered.wait(1))
            self.store.refresh('chain')
            self.assertEqual(self.store.state['current']['price'],450)
            release.set(); worker.join(2); self.assertFalse(worker.is_alive())
        cached=b.Store(self.tmp.name).state
        self.assertEqual(cached['current']['price'],450)
        self.assertEqual(cached['regs'],[reg(1,500)])

    def test_response_cache_avoids_repeated_fit(self):
        with patch.object(self.store,'data',wraps=self.store.data) as compute:
            first=self.store.response(); second=self.store.response()
            self.assertEqual(first,second); self.assertEqual(compute.call_count,1)
            self.store._body_at=0
            self.store.response(); self.assertEqual(compute.call_count,2)

    def test_stale_current_has_no_projection(self):
        now=int(b.time.time()*1000)
        self.store.state.update(regs=[reg(now/b.DAY-2,600),reg(now/b.DAY-1,500)],history_at=now,current=dict(time=now-1000000,price=450,source='chain'))
        data=self.store.data(); self.assertEqual(data['projection'],[])
        self.assertTrue(any('stale' in w for w in data['warnings']))
    def test_cold_start_uses_shipped_chain_seed(self):
        seed=json.loads(b.SEED_FILE.read_text())
        self.assertGreaterEqual(len(seed),20)
        self.assertEqual(self.store.state['regs'],seed)
        self.assertEqual([r['block'] for r in seed],sorted(r['block'] for r in seed))
    def test_fresh_chain_observation_persists_without_credentials(self):
        with patch.object(b,'fetch_chain',return_value=123): self.store.refresh('chain')
        self.assertEqual(b.Store(self.tmp.name).state['current']['price'],123)


class HttpTests(unittest.TestCase):
    def test_ready_health_api_and_public_only(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)/'public'; root.mkdir(); (root/'index.html').write_text('public')
            secret=Path(tmp)/'private'; secret.write_text('private'); (root/'link').symlink_to(secret)
            store=b.Store(str(Path(tmp)/'cache'))
            now=int(b.time.time()*1000)
            store.state.update(regs=[reg(now/b.DAY-1,100)],current=dict(time=now,price=100,source='chain'),history_at=now)
            server=b.Server(('127.0.0.1',0),functools.partial(b.Handler,directory=str(root))); server.store=store
            worker=threading.Thread(target=server.serve_forever,daemon=True); worker.start()
            url=f'http://127.0.0.1:{server.server_port}'
            try:
                self.assertTrue(json.load(urllib.request.urlopen(url+'/healthz'))['ready'])
                self.assertEqual(json.load(urllib.request.urlopen(url+'/api/data'))['current']['price'],100)
                with self.assertRaises(urllib.error.HTTPError): urllib.request.urlopen(url+'/link')
                with self.assertRaises(urllib.error.HTTPError): urllib.request.urlopen(url+'/../private')
                store.state['current']=None
                store._body_at=0
                with self.assertRaises(urllib.error.HTTPError) as caught: urllib.request.urlopen(url+'/healthz')
                self.assertEqual(caught.exception.code,503)
            finally: server.shutdown(); server.server_close(); worker.join()


if __name__=='__main__': unittest.main()
