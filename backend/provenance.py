"""Content identities and reproducible processing manifests (no credentials or cache paths)."""
import hashlib
import json
from functools import lru_cache
from importlib.metadata import version, PackageNotFoundError
from pathlib import Path
from .config import get_config
ROOT = Path(__file__).parent

@lru_cache(maxsize=8)
def _digest(path, size, mtime):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()

def file_digest(path):
    path=Path(path)
    if not path.exists(): return 'missing'
    st=path.stat()
    return _digest(str(path),st.st_size,st.st_mtime_ns)

@lru_cache(maxsize=1)
def dependencies():
    result={}
    for name in ('numpy','astropy','photutils','reproject','scipy','fastapi','pydantic'):
        try: result[name]=version(name)
        except PackageNotFoundError: result[name]='missing'
    return result

def manifest():
    cfg=get_config()
    science={k:v for k,v in cfg.items() if k not in ('cache','allowed_origins')}
    config=hashlib.sha256(json.dumps(science,sort_keys=True).encode()).hexdigest()
    source=hashlib.sha256(''.join(file_digest(p) for p in sorted(ROOT.glob('*.py'))).encode()).hexdigest()
    index=file_digest(ROOT/'data/coarse_index.json.gz')
    calibrations={p.name:file_digest(p) for p in (ROOT/'data/spectral_channels.json',ROOT/'data/channel_map.npy.gz')}
    runtime=hashlib.sha256(json.dumps({'dependencies':dependencies(),'calibrations':calibrations},sort_keys=True).encode()).hexdigest()
    return {'release':cfg['release_tag'],'index_sha256':index,'processing_sha256':source,'config_sha256':config,'runtime_sha256':runtime,'dependencies':dependencies(),'calibrations':calibrations,
            'pixel_scale_arcsec':cfg['pixel_scale_arcsec']/cfg['oversample'],'flag_policy':cfg['flags']}

def identity():
    m=manifest()
    return f"{m['release']}|{m['index_sha256'][:16]}|{m['processing_sha256'][:16]}|{m['config_sha256'][:16]}|{m['runtime_sha256'][:16]}"
