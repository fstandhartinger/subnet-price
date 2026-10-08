# Subnet registration price

Public interactive Bittensor registration cost dashboard. Python standard-library backend; bundled Apache ECharts 5.6.0 frontend. Production port 8000, nonroot container.

Run `TAOSTATS_API=… python backend.py` with the key supplied through your environment, never the client. Current Finney chain price refreshes every five minutes; Taostats history every three hours. Cache is disposable and rebuilt on startup. Last successful values remain visible during upstream outages with freshness warnings.

Historical price points and event provenance, recent-registration range, robust trend fit, and a conditional no-registration decay projection are returned by `/api/data`. `/healthz` is a bounded readiness endpoint.

Tests: `python -m unittest discover -p 'test_*.py'`.
