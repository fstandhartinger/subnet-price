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


def row(day,price,purchase=False):
    import datetime
    return dict(timestamp=datetime.datetime.fromtimestamp(day*86400,datetime.timezone.utc).isoformat(),registration_cost=str(int(price*1e9)),is_purchase=purchase)


class MathTests(unittest.TestCase):
    def test_provider_pre_and_post_purchase_formats(self):
        pts,events,rate=b.history_analysis([row(1,600),row(2,500,True),row(2.001,1000),row(3,900),row(4,1600,True),row(4.001,1599.9),row(5,1500)])
        self.assertEqual([e['price'] for e in events],[500,800])
        self.assertFalse(events[0]['inferred']); self.assertTrue(events[1]['inferred'])
        self.assertAlmostEqual(rate,100,places=5)

    def test_same_timestamp_distinct_blocks_preserve_event(self):
        pre=row(1,500,True); pre['block_number']=10
        post=row(1,1000); post['block_number']=11
        pts,events,_=b.history_analysis([post,pre,dict(pre)])
        self.assertEqual(len(pts),2)
        self.assertEqual(events[0]['price'],500)
        self.assertFalse(events[0]['inferred'])

    def test_jump_without_flag_is_explicitly_inferred(self):
        _,events,_=b.history_analysis([row(1,600),row(2,1000)])
        self.assertEqual(events[0]['price'],500)
        self.assertIn('Inferred jump',events[0]['source'])

    def test_robust_trend_ignores_outlier(self):
        events=[dict(time=i*b.DAY,price=100+10*i+(500 if i==4 else 0)) for i in range(8)]
        trend=b.trend_fit(events)
        self.assertEqual(trend['slope'],10)
        self.assertEqual(trend['intercept'],100)
        self.assertEqual(trend['low'],0)

    def test_crossings_include_first_moving_band_entry(self):
        current=dict(time=int(.25*b.DAY),price=100)
        trend=dict(origin=current['time'],slope=5,intercept=50,low=-10,high=10)
        projection,markers=b.project(current,10,dict(min=20,max=30),trend)
        crossing=next(m for m in markers if 'trend' in m['label'])
        self.assertAlmostEqual((crossing['time']-current['time'])/b.DAY,40/15,places=7)
        self.assertAlmostEqual(next(m for m in markers if 'last' in m['label'])['price'],30)
        self.assertEqual(projection[-1][1],0)

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
        self.store.state.update(rows=[row(now/b.DAY-2,600),row(now/b.DAY-1,500)],history_at=now,current=dict(time=now,price=1000,source='chain'))
        data=self.store.data()
        self.assertEqual(data['registrations'],[])
        self.assertEqual(data['projection'],[])
        self.assertTrue(any('not yet' in w for w in data['warnings']))
    def test_last_good_preserved_on_rate_limit(self):
        self.store.state['rows']=[row(1,100)]
        with patch.dict(b.os.environ,{'TAOSTATS_API':'test-only'}), patch.object(b,'fetch_history',side_effect=b.RateLimited(700)):
            self.store.refresh('history')
        self.assertEqual(self.store.state['rows'],[row(1,100)])
        self.assertGreater(self.store.due['history'],b.time.time()+695)
        self.assertIn('history',self.store.errors)
    def test_consecutive_chain_quotes_update_decay_and_jump_requests_history(self):
        now=int(b.time.time()*1000)
        self.store.state.update(rows=[row(now/b.DAY-2,600),row(now/b.DAY-1,500)],history_at=now)
        self.store.chain_samples=[dict(time=now-b.DAY,price=600,source='chain')]
        with patch.object(b,'fetch_chain',return_value=550): self.store.refresh('chain')
        self.assertAlmostEqual(self.store.data()['rate'],50,places=3)
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
            entered.set(); release.wait(2); return [row(1,500)]
        with patch.dict(b.os.environ,{'TAOSTATS_API':'test-only'}), patch.object(b,'fetch_history',side_effect=history), patch.object(b,'fetch_chain',return_value=450):
            worker=threading.Thread(target=self.store.refresh,args=('history',)); worker.start()
            self.assertTrue(entered.wait(1))
            self.store.refresh('chain')
            self.assertEqual(self.store.state['current']['price'],450)
            release.set(); worker.join(2); self.assertFalse(worker.is_alive())
        cached=b.Store(self.tmp.name).state
        self.assertEqual(cached['current']['price'],450)
        self.assertEqual(cached['rows'],[row(1,500)])

    def test_response_cache_avoids_repeated_fit(self):
        with patch.object(self.store,'data',wraps=self.store.data) as compute:
            first=self.store.response(); second=self.store.response()
            self.assertEqual(first,second); self.assertEqual(compute.call_count,1)
            self.store._body_at=0
            self.store.response(); self.assertEqual(compute.call_count,2)

    def test_stale_current_has_no_projection(self):
        now=int(b.time.time()*1000)
        self.store.state.update(rows=[row(now/b.DAY-2,600),row(now/b.DAY-1,500)],history_at=now,current=dict(time=now-1000000,price=450,source='chain'))
        data=self.store.data(); self.assertEqual(data['projection'],[])
        self.assertTrue(any('stale' in w for w in data['warnings']))
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
            store.state.update(rows=[row(now/b.DAY,100)],current=dict(time=now,price=100,source='chain'),history_at=now)
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
