#!/usr/bin/env python3
"""Build Craft against sibling source checkouts without changing them.

Usage: python3 scripts/dev/build-local-workspace.py /absolute/new/output-directory [craft-eval-package-directory]
The output contains isolated copies, installed dependencies and plugin artifacts.
Requires sibling craft, craft-common and craft-capability checkouts and the exact
craft-eval package installed in craft/node_modules.
Requires Node >= 23, pnpm 11.19.0, and access to the configured npm registry.
"""
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

if len(sys.argv) not in (2, 3):
    raise SystemExit(__doc__)
source = Path(__file__).resolve().parents[2].parent
output = Path(sys.argv[1]).resolve()
if output.exists():
    raise SystemExit(f"Output already exists: {output}")
if output == source or source in output.parents:
    raise SystemExit("Output must be outside the source workspace")
eval_package = Path(sys.argv[2]).resolve() if len(sys.argv) == 3 else source / 'craft/node_modules/craft-eval'
expected_eval = json.loads((source / 'craft/package.json').read_text())['dependencies']['craft-eval']
if not (eval_package / 'package.json').is_file() or json.loads((eval_package / 'package.json').read_text())['version'] != expected_eval:
    raise SystemExit(f'Provide craft-eval@{expected_eval} as the second argument or install it in craft/node_modules')
output.mkdir(parents=True)
ignore = shutil.ignore_patterns('.git', 'node_modules', 'dist', '.craft_data', '.turbo', '.env', '.env.*', '*.pem', '*.key')
for name in ('craft', 'craft-common', 'craft-capability'):
    shutil.copytree(source / name, output / name, ignore=ignore, symlinks=True)
shutil.copytree(eval_package.resolve(), output / 'craft-eval', symlinks=False)
packages = list((output / 'craft-common/packages').glob('*/package.json')) + list((output / 'craft-capability/capability').glob('*/package.json'))
names = [json.loads(path.read_text())['name'] for path in packages] + ['craft-eval']
workspace = ['packages:', '  - craft', '  - craft/adapters/*', '  - craft-eval', '  - craft-capability', '  - craft-common/packages/*', '  - craft-capability/capability/*', 'autoInstallPeers: false', 'linkWorkspacePackages: false', 'allowBuilds:', '  esbuild: true', '  tesseract.js: false', 'overrides:']
workspace.extend(f"  '{name}': workspace:*" for name in names)
workspace.extend(["  '@types/node': 25.9.5", "  typescript: 6.0.3"])
(output / 'pnpm-workspace.yaml').write_text('\n'.join(workspace) + '\n')
(output / 'package.json').write_text(json.dumps({'name': 'craft-local-build', 'private': True, 'packageManager': 'pnpm@11.19.0'}) + '\n')
# Nested workspace markers would cause pnpm to select separate dependency graphs.
for name in ('craft', 'craft-common', 'craft-capability'):
    (output / name / 'pnpm-workspace.yaml').unlink(missing_ok=True)

env = os.environ.copy()
env['PATH'] = str(output / 'craft/node_modules/.bin') + os.pathsep + env.get('PATH', '')

def run(*args, cwd=output):
    print('+', ' '.join(map(str, args)), flush=True)
    subprocess.run(args, cwd=cwd, env=env, check=True)

run('pnpm', 'install', '--no-frozen-lockfile')
run('pnpm', '--filter', 'craft-common-store-local', 'run', 'build')
run('pnpm', '--filter', 'craft-common-base', '--filter', 'craft-common-ontology', 'run', 'build')
run('pnpm', '--filter', 'craft-common-log', 'run', 'build')
run('pnpm', '--filter', '@craft/capability-memory', 'run', 'build')
run('pnpm', '--filter', '@craft/capability-knowledge', '--filter', '@craft/capability-codebase', '--filter', '@craft/capability-datasec', '--filter', '@craft/craft-notes', 'run', 'build')
run('pnpm', '--filter', '@craft/capability-experience', '--filter', '@craft/capability-context', 'run', 'build')
run('pnpm', '--filter', 'craft', 'run', 'build')
run('pnpm', '--filter', 'craft', 'run', 'typecheck')
print(f'Plugin output: {output / "craft/plugins/craft-context/dist"}')
