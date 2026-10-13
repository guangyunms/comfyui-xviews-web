"""Stage only public program resources for GitHub Pages."""
import hashlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent
OUTPUT = ROOT / '_site'
FILES = ['index.html', 'styles.css', 'app.js', 'db-worker.js', 'manifest.webmanifest', 'service-worker.js', 'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png', 'vendor/sqlite3.mjs', 'vendor/sqlite3.wasm', 'vendor/sqlite3-opfs-async-proxy.js', 'vendor/package-info.json', 'vendor/UPSTREAM-README.txt']


def main():
    if OUTPUT.is_symlink():
        raise RuntimeError('Staging must not be a symbolic link')
    OUTPUT.mkdir(exist_ok=True)
    allowed = set(FILES)
    for path in OUTPUT.rglob('*'):
        if path.is_symlink() or (path.is_file() and path.relative_to(OUTPUT).as_posix() not in allowed):
            raise RuntimeError('Unexpected file in staging: ' + str(path))
    digest = hashlib.sha256()
    for name in FILES:
        path = ROOT / name
        if path.is_symlink() or not path.resolve().is_relative_to(ROOT):
            raise RuntimeError('Program resources must stay within this repository: ' + name)
        digest.update(name.encode())
        digest.update(path.read_bytes())
    revision = digest.hexdigest()[:16]
    for name in FILES:
        data = (ROOT / name).read_bytes()
        if name == 'service-worker.js':
            data = data.replace(b"CACHE_PREFIX + 'v1'", ("CACHE_PREFIX + '" + revision + "'").encode())
        path = OUTPUT / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
    print('Staged ' + str(len(FILES)) + ' program resources; revision ' + revision)


if __name__ == '__main__':
    main()
