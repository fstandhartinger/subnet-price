# Subnet registration price

Public interactive Bittensor registration cost dashboard. Python standard-library backend; bundled Apache ECharts 5.6.0 frontend. Production port 8000, nonroot container.

Run `TAOSTATS_API=… python backend.py` with the key supplied through your environment, never the client. Current Finney chain price refreshes every five minutes; Taostats history every three hours. Cache is disposable and rebuilt on startup. Last successful values remain visible during upstream outages with freshness warnings.

Historical price points and event provenance, recent-registration range, robust trend fit, and a conditional no-registration decay projection are returned by `/api/data`. `/healthz` is a bounded readiness endpoint.

Tests: `python -m unittest discover -p 'test_*.py'`.

The conservative trend band uses the last eight registrations, a Theil–Sen slope, and 50th–90th residual percentiles. Its fit is raised by at least half the old 10th–90th residual spread, and at the latest registration is no lower than the higher last-eight/last-four median. The safe estimate marks first upper-edge touch (or now if already reached). This is a deliberate planning buffer, not a probability interval.

The conservative ribbon has a minimum width of 30% of the raised trend value (±15% shifted upward). A lighter uncertainty ribbon above it adds the greater of residual population SD, the 95th–90th residual percentile difference, or 15% of the trend. The earliest-likely card uses this buffer upper edge; a separate marker keeps the conservative-edge crossing. Tooltips show the original central fit, conservative upper edge and buffer budget in TAO/USD. Neither ribbon is a calibrated confidence interval.

The Docker build assigns content-hashed filenames to chart JavaScript and CSS. This prevents stale scripts from being cached under a new query string during rolling deployments.

Fan: the robust last-eight fit is enclosed by the full residual envelope plus 2% margin, with minimum ±15% of median paid price. After the latest observed registration, both edges widen quadratically: one median successive price move (minimum 10%) over 14 days. The outer fan adds max(residual SD, 10% of median price) and widens 1.7x as fast. Buffer-upper and main-upper crossings use bounded bisection of the piecewise concave decay-minus-edge gap. These are planning margins, not probabilities.

The chart is the first main section. Desktop and mobile default to 10 August 2026 through the current time at page load (UTC). The 10 Aug–today button restores that range; 30d/90d/All presets still include the conditional future projection.
