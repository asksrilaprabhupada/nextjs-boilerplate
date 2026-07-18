"""Put the harness directory (scripts/tags-rebuild) on sys.path so the tests can
`import config` / `import tagging` the same way the harness modules import each
other (they are flat top-level modules, not a package)."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
