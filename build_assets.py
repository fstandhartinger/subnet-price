"""Give built assets immutable names so rolling deployments cannot mix revisions."""
import hashlib
from pathlib import Path
import re
import sys

root = Path(sys.argv[1])
index = root / 'index.html'
html = index.read_text()
for name in ('app.js', 'style.css'):
    source = root / name
    versioned = f'{source.stem}.{hashlib.sha256(source.read_bytes()).hexdigest()[:16]}{source.suffix}'
    source.rename(root / versioned)
    html = re.sub(r'/' + re.escape(name) + r'(?:\?[^"\s]*)?', '/' + versioned, html)
index.write_text(html)
