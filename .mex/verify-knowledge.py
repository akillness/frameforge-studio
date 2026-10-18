"""Offline structure checks for FrameForge's authored knowledge and role contracts."""
from pathlib import Path
import hashlib
import json
import re

ROOT = Path(__file__).resolve().parents[1]
vault = ROOT / 'llm-wiki'
errors = []
required = ['AGENTS.md', 'index.md', 'log.md', 'raw/sources', 'raw/assets',
            'wiki/sources', 'wiki/entities', 'wiki/concepts', 'wiki/queries', 'wiki/reports']
for item in required:
    if not (vault / item).exists():
        errors.append(f'missing vault path: {item}')
pages = {p.relative_to(vault).with_suffix('').as_posix(): p
         for p in vault.rglob('*.md') if 'raw' not in p.relative_to(vault).parts and p.name != 'AGENTS.md'}
inbound = dict.fromkeys(pages, 0)
for key, path in pages.items():
    text = path.read_text(encoding='utf-8')
    for target in re.findall(r'\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]', text):
        target = target.removesuffix('.md').strip('/')
        if target not in pages:
            errors.append(f'{key}: unresolved wiki link {target}')
        elif target != key:
            inbound[target] += 1
    if key.startswith('wiki/'):
        match = re.match(r'^---\n(.*?)\n---\n', text, re.S)
        for field in ('type', 'title', 'description', 'timestamp'):
            if not match or not re.search(rf'^{field}:\s*\S', match[1], re.M):
                errors.append(f'{key}: missing OKF field {field}')
for page, count in inbound.items():
    if page not in ('index', 'log') and not count:
        errors.append(f'orphan page: {page}')
manifest = json.loads((vault / 'raw/source-manifest.json').read_text(encoding='utf-8'))
for source in manifest['files']:
    path = (vault / 'raw' / source['path']).resolve()
    if not path.is_relative_to((vault / 'raw').resolve()):
        errors.append('source path escapes raw directory')
    elif hashlib.sha256(path.read_bytes()).hexdigest() != source['sha256']:
        errors.append(f'raw source changed: {source["path"]}')
roles = list((ROOT / '.claude/agents').glob('*.md'))
for path in roles:
    text = path.read_text(encoding='utf-8')
    for required in ('name:', 'description:', '## Core Responsibilities', '## Input Protocol',
                     '## Output Protocol', '## Error Handling', '## Team Communication'):
        if required not in text:
            errors.append(f'{path.name}: missing {required}')
    if len(text.splitlines()) > 200:
        errors.append(f'{path.name}: agent contract exceeds 200 lines')
if len(roles) != 5:
    errors.append('expected supervisor and four specialist contracts')
skill = (ROOT / '.claude/skills/production-orchestrator/SKILL.md').read_text(encoding='utf-8')
for required in ('name: production-orchestrator', '## When to use this skill', '## Instructions',
                 '## Examples', '## Best practices'):
    if required not in skill:
        errors.append(f'orchestrator: missing {required}')
result = {'ok': not errors, 'wikiPages': len(pages), 'okfAtoms': sum(k.startswith('wiki/') for k in pages),
          'agentContracts': len(roles), 'immutableSources': len(manifest['files']), 'errors': errors,
          'limits': 'Structural validation only; not model trigger accuracy or comparative production quality.'}
print(json.dumps(result, ensure_ascii=False, indent=2))
raise SystemExit(bool(errors))
