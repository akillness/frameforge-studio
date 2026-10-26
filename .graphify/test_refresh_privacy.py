"""Offline privacy regressions using real admission and isolated refresh fixtures."""
import hashlib
import json
import os
from copy import deepcopy
from pathlib import Path
import shutil
import runpy
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
from textwrap import dedent

ROOT = Path(__file__).resolve().parents[1]
refresh = runpy.run_path(str(ROOT / '.graphify/refresh.py'))
exclude_checkout_local_state = refresh['exclude_checkout_local_state']
exclude_unadmitted_wiki = refresh['exclude_unadmitted_wiki']
load_knowledge_admission = refresh['load_knowledge_admission']
normalize_edges = refresh['normalize_edges']


class PrivacyBoundaryTest(unittest.TestCase):
    def test_private_file_matching_keeps_public_siblings(self):
        for private_path in ('.mcp.json', './.mcp.json', r'.\.mcp.json'):
            with self.subTest(private_path=private_path):
                public_nodes = [
                    {'id': 'example', 'source_file': '.mcp.json.example'},
                    {'id': 'jsonc', 'source_file': './.mcp.jsonc'},
                    {'id': 'directory', 'source_file': r'.mcp.json-examples\guide.md'},
                    {'id': 'nested', 'source_file': 'docs/.mcp.json'},
                ]
                public_links = [
                    {'source': 'example', 'target': 'jsonc',
                     'source_file': '.mcp.json.example'},
                    {'source': 'jsonc', 'target': 'directory',
                     'source_file': r'.\.mcp.jsonc'},
                ]
                graph = {'nodes': deepcopy(public_nodes) + [
                             {'id': 'private', 'source_file': private_path}],
                         'links': deepcopy(public_links) + [
                             {'source': 'example', 'target': 'jsonc',
                              'source_file': private_path}]}

                audit = exclude_checkout_local_state(graph)

                self.assertEqual(graph, {'nodes': public_nodes, 'links': public_links})
                self.assertEqual(audit['nodesRemoved'], 1)
                self.assertEqual(audit['edgesRemoved'], 1)

    def test_private_directory_boundaries_and_path_spellings(self):
        directories = (
            '.jeo', '.omc', '.omx', '.ouroboros', '.zvec-grep',
            'artifacts/production-workspace-implementation/native-status',
            'llm-wiki/.graphify', 'llm-wiki/.state',
        )
        spellings = (
            ('posix', '', '/'),
            ('relative-posix', './', '/'),
            ('windows', '', chr(92)),
            ('relative-windows', '.' + chr(92), chr(92)),
        )
        for directory in directories:
            for spelling, leading, separator in spellings:
                with self.subTest(directory=directory, spelling=spelling):
                    private_nodes = [
                        {'id': 'root', 'source_file': directory},
                        {'id': 'child', 'source_file': directory + '/state.json'},
                        {'id': 'descendant', 'source_file': directory + '/runs/local.py'},
                    ]
                    public_nodes = [
                        {'id': 'lookalike', 'source_file': directory + '-public/guide.md'},
                        {'id': 'nested', 'source_file': 'docs/' + directory + '/guide.md'},
                    ]
                    for node in private_nodes + public_nodes:
                        node['source_file'] = leading + node['source_file'].replace('/', separator)
                    graph = {'nodes': private_nodes + deepcopy(public_nodes), 'links': []}

                    audit = exclude_checkout_local_state(graph)

                    self.assertEqual(graph, {'nodes': public_nodes, 'links': []})
                    self.assertEqual(audit['nodesRemoved'], 3)
                    self.assertEqual(audit['edgesRemoved'], 0)

    def test_pruning_preserves_metadata_and_existing_external_references(self):
        public_nodes = [
            {'id': 'app', 'source_file': 'public/app.js', 'label': 'Application'},
            {'id': 'lib', 'source_file': 'server/lib.js', 'label': 'Library'},
        ]
        private_nodes = [
            {'id': 'agent', 'source_file': '.ouroboros/session.json'},
            {'id': 'index', 'source_file': '.zvec-grep/index.json'},
            {'id': 'native', 'source_file':
             'artifacts/production-workspace-implementation/native-status/probe.json'},
            {'id': 'credentials', 'source_file': '.mcp.json'},
        ]
        canonical_links = [
            {'source': 'app', 'target': 'lib', 'source_file': 'public/app.js',
             'metadata': {'line': 8, 'kind': 'call'}},
            {'source': 'app', 'target': 'lib', 'source_file': 'public/app.js',
             'metadata': {'line': 12, 'kind': 'import'}},
            {'source': 'app', 'target': 'external:react', 'source_file': 'public/app.js',
             'metadata': {'specifier': 'react', 'kind': 'import'}},
            {'source': 'lib', 'target': 'external:path',
             'metadata': {'specifier': 'node:path', 'kind': 'import'}},
            {'source': 'lib', 'target': 'external:example',
             'source_file': '.mcp.json.example', 'metadata': {'kind': 'reference'}},
        ]
        removed_links = []
        for node in private_nodes:
            removed_links.extend([
                {'source': node['id'], 'target': 'lib', 'source_file': 'public/app.js'},
                {'source': 'app', 'target': node['id']},
                {'source': 'app', 'target': 'lib', 'source_file': node['source_file']},
                {'source': node['id'], 'target': 'external:private'},
            ])
        graph = {'nodes': deepcopy(public_nodes + private_nodes),
                 'links': deepcopy(canonical_links + removed_links)}
        before_ids = {node['id'] for node in graph['nodes']}
        before_external = {edge[field] for edge in graph['links']
                           for field in ('source', 'target') if edge[field] not in before_ids}

        audit = exclude_checkout_local_state(graph)

        self.assertEqual(graph, {'nodes': public_nodes, 'links': canonical_links})
        self.assertEqual(audit['nodesRemoved'], len(private_nodes))
        self.assertEqual(audit['edgesRemoved'], len(removed_links))
        after_ids = {node['id'] for node in graph['nodes']}
        after_external = {edge[field] for edge in graph['links']
                          for field in ('source', 'target') if edge[field] not in after_ids}
        self.assertEqual(after_external, before_external - {'external:private'})
        self.assertFalse(after_external & before_ids,
                         'Filtering must not turn a formerly resolved endpoint into a dangling link')

    def test_empty_and_public_graphs_remain_unchanged(self):
        graphs = (
            ('empty', {'nodes': [], 'links': []}),
            ('public', {
                'nodes': [{'id': 'doc', 'source_file': 'llm-wiki/wiki/reports/workspace.md'},
                          {'id': 'symbol', 'label': 'Unlocated symbol'},
                          {'id': 'reference', 'source_file': None}],
                'links': [{'source': 'doc', 'target': 'symbol',
                           'metadata': {'kind': 'documents'}},
                          {'source': 'reference', 'target': 'external:package',
                           'source_file': None, 'metadata': {'kind': 'import'}}],
                'metadata': {'label': 'Canonical structural graph'},
            }),
        )
        for name, original in graphs:
            with self.subTest(graph=name):
                graph = deepcopy(original)

                audit = exclude_checkout_local_state(graph)

                self.assertEqual(graph, original)
                self.assertEqual(audit['nodesRemoved'], 0)
                self.assertEqual(audit['edgesRemoved'], 0)


    def test_case_aliased_checkout_state_is_pruned_from_both_binary_collections(self):
        public_nodes = [{'id': 'app', 'source_file': 'public/app.js'},
                        {'id': 'example', 'source_file': '.mcp.json.example'},
                        {'id': 'sibling', 'source_file': '.OMC-tools/guide.md'}]
        private_nodes = [
            {'id': 'omc', 'source_file': './.OMC/session.json'},
            {'id': 'omx', 'source_file': r'.\.OmX\runs\state.json'},
            {'id': 'mcp', 'source_file': '.MCP.JSON'},
            {'id': 'state', 'source_file': 'LLM-WIKI/.STATE/queue.json'},
        ]
        canonical = {'source': 'app', 'target': 'example', 'source_file': 'public/app.js',
                     'metadata': {'line': 9, 'kind': 'public'}}
        rejected = [{'source': 'app', 'target': node['id']} for node in private_nodes]
        rejected += [{'source': node['id'], 'target': 'app'} for node in private_nodes]
        rejected += [{'source': 'app', 'target': 'example', 'source_file': node['source_file']}
                     for node in private_nodes]
        graph = {'nodes': deepcopy(public_nodes + private_nodes),
                 'links': deepcopy([canonical] + rejected),
                 'edges': deepcopy([canonical] + rejected),
                 'metadata': {'label': 'Mixed private boundaries'}}

        audit = exclude_checkout_local_state(graph)

        self.assertEqual(graph, {'nodes': public_nodes, 'links': [canonical],
                                 'edges': [canonical],
                                 'metadata': {'label': 'Mixed private boundaries'}})
        self.assertEqual(audit['nodesRemoved'], len(private_nodes))
        self.assertEqual(audit['edgesRemoved'], 2 * len(rejected))

    def test_full_record_dedupe_normalizes_each_present_binary_collection(self):
        first = {'source': 'a', 'target': 'b',
                 'metadata': {'line': 2, 'roles': ['author', 'evidence']}}
        reordered = {'metadata': {'roles': ['author', 'evidence'], 'line': 2},
                     'target': 'b', 'source': 'a'}
        different = deepcopy(first)
        different['metadata']['line'] = 3
        ordered = deepcopy(first)
        ordered['metadata']['roles'].reverse()
        graph = {'nodes': [{'id': 'a'}, {'id': 'b'}],
                 'links': [first, reordered, different, ordered],
                 'edges': [first, reordered, different, ordered],
                 'metadata': {'label': 'Separate binary collection identity'}}
        expected = deepcopy({'nodes': graph['nodes'],
                             'links': [first, different, ordered],
                             'edges': [first, different, ordered],
                             'metadata': graph['metadata']})

        audit = normalize_edges(graph)

        self.assertEqual(graph, expected)
        self.assertEqual(audit['raw'], 8)
        self.assertEqual(audit['exactUnique'], 6)
        self.assertEqual(audit['exactDuplicatesRemoved'], 2)
        self.assertIs(graph['links'][0], first)
        self.assertIs(graph['edges'][0], first)
        self.assertEqual(normalize_edges(graph)['exactDuplicatesRemoved'], 0)


class WikiAdmissionTest(unittest.TestCase):
    def put(self, path, content):
        target = self.root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content.encode('utf-8') if isinstance(content, str) else content)

    def save_policy(self, policy):
        self.put('harness/knowledge-policy.json', json.dumps(policy, ensure_ascii=False) + '\n')

    def knowledge(self, *arguments):
        result = subprocess.run(
            ['node', 'scripts/knowledge.mjs', *arguments, '--root', str(self.root)],
            cwd=self.root, capture_output=True, text=True, encoding='utf-8', timeout=30)
        return result, json.loads(result.stdout)

    def setUp(self):
        directory = tempfile.TemporaryDirectory(prefix='frameforge-graph-admission-')
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        for path in ('scripts/knowledge.mjs', 'server/project-knowledge.mjs',
                     '.graphify/refresh.py'):
            target = self.root / path
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / path, target)
        bundle = json.dumps({'schema': 'frameforge-harness-bundle/v1', 'version': '1.0.0'})
        self.put('harness/versions/1.0.0/bundle.json', bundle)
        self.put('harness/manifest.json', json.dumps({
            'schema': 'frameforge-harness-current/v1', 'currentVersion': '1.0.0',
            'bundlePath': 'versions/1.0.0',
            'bundleSha256': hashlib.sha256(bundle.encode('utf-8')).hexdigest(),
        }))
        self.evidence_path = 'llm-wiki/wiki/sources/evidence-only.md'
        self.raw_path = 'llm-wiki/raw/sources/capture.md'
        self.put(self.evidence_path, '# Evidence pointer only\nNot an admitted body.\n')
        self.put(self.raw_path, '# Raw captured prompt\nDo not export this body.\n')
        self.policy = {
            'schema': 'frameforge-knowledge-policy/v1', 'indexPath': 'llm-wiki/index.md',
            'limits': {'maxFiles': 32, 'maxFileBytes': 65536, 'maxCorpusBytes': 262144,
                       'maxResults': 10, 'maxCharacters': 16000,
                       'maxExcerptCharacters': 1200, 'maxQueryCharacters': 256},
            'entries': [],
        }
        for folder, title, kind, provenance in (
                ('sources', 'Reviewed source', 'Source', 'authored-source'),
                ('concepts', 'Reviewed concept', 'Concept', 'authored-synthesis'),
                ('reports', 'Historical report', 'Report', 'historical-report')):
            path = 'llm-wiki/wiki/' + folder + '/reviewed.md'
            content = ('---\ntype: ' + kind + '\ntitle: ' + title + '\n'
                       'description: Reviewed graph admission fixture.\n'
                       'timestamp: 2026-10-26T00:00:00Z\n---\n\n# ' + title + '\n'
                       'Historical reference, not present operational readiness.\n')
            self.put(path, content)
            self.policy['entries'].append({
                'path': path, 'title': title, 'type': kind,
                'classification': 'historical' if kind == 'Report' else 'authored-reference',
                'sha256': hashlib.sha256(content.encode('utf-8')).hexdigest(),
                'provenance': {'kind': provenance,
                               'evidence': [self.evidence_path, self.raw_path]},
            })
        self.save_policy(self.policy)
        self.put('llm-wiki/index.md', '# Preserved historical bookkeeping\n')
        result, rendered = self.knowledge('index', '--write')
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        self.assertTrue(rendered['ok'], rendered)
        self.admission = load_knowledge_admission(root=self.root)
        self.assertEqual({entry['path'] for entry in self.admission['entries']},
                         {entry['path'] for entry in self.policy['entries']})
        self.refresh = runpy.run_path(str(self.root / '.graphify/refresh.py'))
        self.source_scope = self.refresh['source_scope']

    def test_exact_admitted_bodies_keep_nonwiki_structure_but_not_evidence_or_navigation(self):
        admitted_nodes = [
            {'id': entry['type'], 'source_file': entry['path'],
             'metadata': {'classification': entry['classification'], 'labels': ['검토됨']}}
            for entry in self.policy['entries']
        ]
        public_nodes = admitted_nodes + [
            {'id': 'app', 'source_file': 'public/app.js'},
            {'id': 'lib', 'source_file': 'server/project-knowledge.mjs'},
            {'id': 'nested', 'source_file': 'docs/llm-wiki/wiki/sources/reviewed.md'},
            {'id': 'sibling', 'source_file': 'llm-wiki-public/guide.md'},
            {'id': 'symbol', 'label': 'Unlocated existing symbol'},
        ]
        rejected_paths = (
            self.raw_path, self.evidence_path,
            'llm-wiki/wiki/sources/2026-10-26-123456-submitted-prompt.md',
            'llm-wiki/wiki/queries/prompt-query.md',
            'llm-wiki/wiki/concepts/unreviewed.md',
            'llm-wiki/index.md', 'llm-wiki/log.md', 'llm-wiki/AGENTS.md',
            'llm-wiki/wiki/index.md', 'llm-wiki/wiki/log.md', 'llm-wiki/wiki/AGENTS.md',
            'llm-wiki/.graphify/graph.json', 'llm-wiki/.state/admission.json',
        )
        private_nodes = [{'id': 'rejected-' + str(index), 'source_file': path}
                         for index, path in enumerate(rejected_paths)]
        canonical_links = [
            {'source': 'Source', 'target': 'Concept',
             'source_file': self.policy['entries'][0]['path'],
             'metadata': {'kind': 'reference', 'line': 11}},
            {'source': 'Report', 'target': 'Source', 'metadata': {'kind': 'historical'}},
            {'source': 'app', 'target': 'lib', 'source_file': 'public/app.js',
             'metadata': {'kind': 'import', 'line': 3}},
            {'source': 'symbol', 'target': 'external:package',
             'metadata': {'kind': 'existing-external-reference'}},
        ]
        canonical_hyperedges = [
            {'id': 'authored', 'nodes': ['Source', 'Concept', 'Report'],
             'source_file': self.policy['entries'][0]['path'],
             'metadata': {'kind': 'authored-group', 'weight': 3}},
            {'id': 'code', 'nodes': ['app', 'lib', 'external:package'],
             'source_file': 'public/app.js', 'metadata': {'kind': 'code-group'}},
        ]
        rejected_hyperedges = []
        rejected_links = []
        for node in private_nodes:
            rejected_links.extend([
                {'source': 'app', 'target': node['id']},
                {'source': node['id'], 'target': 'lib', 'source_file': 'public/app.js'},
                {'source': node['id'], 'target': 'external:private'},
                {'source': 'app', 'target': 'lib', 'source_file': node['source_file']},
            ])
            rejected_hyperedges.extend([
                {'nodes': ['app', node['id'], 'lib'], 'source_file': 'public/app.js'},
                {'nodes': ['app', 'lib'], 'source_file': node['source_file']},
            ])
        admission_before = deepcopy(self.admission)
        for field in ('links', 'edges'):
            with self.subTest(field=field):
                metadata = {'label': 'Canonical graph', 'layout': {'seed': 7},
                            'provenance': {'generator': 'native'}}
                graph = {'nodes': deepcopy(public_nodes + private_nodes),
                         field: deepcopy(canonical_links + rejected_links),
                         'hyperedges': deepcopy(canonical_hyperedges + rejected_hyperedges),
                         'metadata': deepcopy(metadata)}

                audit = exclude_unadmitted_wiki(graph, self.admission)

                self.assertEqual(graph, {'nodes': public_nodes, field: canonical_links,
                                         'hyperedges': canonical_hyperedges,
                                         'metadata': metadata})
                self.assertEqual(audit['nodesRemoved'], len(private_nodes))
                self.assertEqual(audit['edgesRemoved'], len(rejected_links))
                self.assertEqual(audit['hyperedgesRemoved'], len(rejected_hyperedges))
                self.assertEqual(audit['admittedFiles'],
                                 sorted(entry['path'] for entry in self.policy['entries']))
                self.assertEqual(self.admission, admission_before)
                repeated = exclude_unadmitted_wiki(graph, self.admission)
                self.assertEqual(repeated['nodesRemoved'], 0)
                self.assertEqual(repeated['edgesRemoved'], 0)
                self.assertEqual(repeated['hyperedgesRemoved'], 0)
        mixed = {'nodes': deepcopy(public_nodes + private_nodes),
                 'links': deepcopy(canonical_links + rejected_links),
                 'edges': deepcopy(canonical_links + rejected_links)}

        mixed_audit = exclude_unadmitted_wiki(mixed, self.admission)

        self.assertEqual(mixed, {'nodes': public_nodes, 'links': canonical_links,
                                 'edges': canonical_links})
        self.assertEqual(mixed_audit['edgesRemoved'], 2 * len(rejected_links))

    def test_admission_is_exact_and_case_sensitive_after_portable_path_normalization(self):
        path = self.policy['entries'][0]['path']
        admitted_spellings = (path, './' + path, '././' + path,
                              path.replace('/', chr(92)),
                              ('.\\.\\' + path.replace('/', chr(92))))
        rejected_spellings = (path + '.backup', path + '/child.md',
                              path.replace('/reviewed.md', '/reviewed-copy.md'),
                              path.replace('/reviewed.md', '/REVIEWED.md'),
                              path.replace('llm-wiki/', 'LLM-WIKI/', 1),
                              '././' + self.raw_path,
                              ('.\\LLM-WIKI\\raw\\sources\\capture.md'))
        allowed_nodes = [{'id': 'admitted-' + str(index), 'source_file': spelling}
                         for index, spelling in enumerate(admitted_spellings)]
        rejected_nodes = [{'id': 'rejected-' + str(index), 'source_file': spelling}
                          for index, spelling in enumerate(rejected_spellings)]
        graph = {'nodes': deepcopy(allowed_nodes + rejected_nodes),
                 'links': [{'source': allowed_nodes[0]['id'], 'target': node['id']}
                           for node in rejected_nodes]}

        audit = exclude_unadmitted_wiki(graph, self.admission)

        self.assertEqual(graph, {'nodes': allowed_nodes, 'links': []})
        self.assertEqual(audit['nodesRemoved'], len(rejected_nodes))
        self.assertEqual(audit['edgesRemoved'], len(rejected_nodes))

    def test_filter_then_full_record_dedupe_preserves_first_records_and_metadata(self):
        path = self.policy['entries'][0]['path']
        nodes = [{'id': 'source', 'source_file': path},
                 {'id': 'app', 'source_file': 'public/app.js'}]
        first = {'source': 'source', 'target': 'app', 'source_file': path,
                 'metadata': {'kind': 'reference', 'line': 2, 'roles': ['author', 'evidence']}}
        reordered = {'metadata': {'roles': ['author', 'evidence'], 'line': 2,
                                  'kind': 'reference'},
                     'source_file': path, 'target': 'app', 'source': 'source'}
        different_line = deepcopy(first)
        different_line['metadata']['line'] = 3
        different_order = deepcopy(first)
        different_order['metadata']['roles'].reverse()
        rejected = {'source': 'source', 'target': 'app', 'source_file': self.raw_path}
        for field in ('links', 'edges'):
            with self.subTest(field=field):
                graph = {'nodes': list(nodes),
                         field: [first, reordered, different_line, different_order,
                                 rejected, deepcopy(rejected)],
                         'metadata': {'label': '한글 graph', 'layout': {'seed': 17}}}
                expected = deepcopy({'nodes': nodes,
                                     field: [first, different_line, different_order],
                                     'metadata': graph['metadata']})

                privacy = exclude_unadmitted_wiki(graph, self.admission)
                normalization = normalize_edges(graph)

                self.assertEqual(graph, expected)
                self.assertEqual(privacy['nodesRemoved'], 0)
                self.assertEqual(privacy['edgesRemoved'], 2)
                self.assertEqual(normalization['raw'], 4)
                self.assertEqual(normalization['exactUnique'], 3)
                self.assertEqual(normalization['exactDuplicatesRemoved'], 1)
                self.assertIs(graph['nodes'][0], nodes[0])
                self.assertIs(graph[field][0], first)
                self.assertIs(graph[field][1], different_line)
                self.assertIs(graph[field][2], different_order)

    def test_root_knowledge_index_snapshots_never_enter_exported_graph(self):
        sentinel = 'PRIVATE_ROOT_STATE_SNAPSHOT_SENTINEL'
        snapshot_directory = '.state/knowledge-index-fixture'
        private_paths = ('.state', '.state/', snapshot_directory,
                         snapshot_directory + '/original-index.md',
                         snapshot_directory + '/candidate-index.md')
        for path in private_paths[-2:]:
            self.put(path, '# ' + sentinel + '\nSynthetic snapshot: ' + path + '\n')
        authored_path = self.policy['entries'][0]['path']
        public_content = {
            'public/app.js': b'export const app = 1;\n',
            authored_path: (self.root / authored_path).read_bytes(),
            '.state-public/knowledge-index-fixture/original-index.md': b'# Public sibling\n',
            'docs/.state/knowledge-index-fixture/candidate-index.md': b'# Public nested guide\n',
        }
        for path, content in public_content.items():
            self.put(path, content)
        public_nodes = [
            {'id': 'app', 'source_file': 'public/app.js'},
            {'id': 'authored', 'source_file': authored_path},
            {'id': 'sibling', 'source_file':
             '.state-public/knowledge-index-fixture/original-index.md'},
            {'id': 'nested', 'source_file':
             'docs/.state/knowledge-index-fixture/candidate-index.md'},
        ]
        public_edges = [
            {'source': 'app', 'target': 'authored', 'source_file': authored_path,
             'metadata': {'kind': 'authored-reference', 'line': 2}},
            {'source': 'authored', 'target': 'sibling', 'metadata': {'kind': 'guide'}},
            {'source': 'nested', 'target': 'external:package',
             'metadata': {'kind': 'existing-reference'}},
        ]
        public_hyperedges = [{'id': 'public-group', 'nodes': ['app', 'authored', 'sibling'],
                              'source_file': authored_path}]
        expected = {'nodes': public_nodes, 'links': public_edges, 'edges': public_edges,
                    'hyperedges': public_hyperedges,
                    'metadata': {'label': 'Reviewed structural graph'}}
        spellings = (
            ('posix', '', '/', False),
            ('relative-posix', './', '/', False),
            ('repeated-relative-posix', '././', '/', False),
            ('windows', '', chr(92), False),
            ('repeated-relative-windows', '.\\.\\', chr(92), False),
            ('case-aliased', './', '/', True),
        )
        for spelling, leading, separator, uppercase in spellings:
            with self.subTest(spelling=spelling):
                private_nodes = [
                    {'id': 'private-' + str(index),
                     'source_file': leading + (path.upper() if uppercase else path).replace('/', separator),
                     'label': sentinel, 'metadata': {'body': sentinel + ':' + path}}
                    for index, path in enumerate(private_paths)
                ]
                rejected_edges = []
                rejected_hyperedges = []
                for node in private_nodes:
                    rejected_edges.extend([
                        {'source': node['id'], 'target': 'app', 'metadata': {'body': sentinel}},
                        {'source': 'authored', 'target': node['id'], 'metadata': {'body': sentinel}},
                        {'source': 'app', 'target': 'authored', 'source_file': node['source_file'],
                         'metadata': {'body': sentinel}},
                    ])
                    rejected_hyperedges.extend([
                        {'nodes': ['app', node['id']], 'metadata': {'body': sentinel}},
                        {'nodes': ['app', 'authored'], 'source_file': node['source_file'],
                         'metadata': {'body': sentinel}},
                    ])
                graph = deepcopy(expected)
                graph['nodes'].extend(private_nodes)
                for field in ('links', 'edges'):
                    graph[field] = deepcopy(public_edges + rejected_edges + [public_edges[0]])
                graph['hyperedges'].extend(rejected_hyperedges)

                privacy = exclude_checkout_local_state(graph)
                admission = exclude_unadmitted_wiki(graph, self.admission)
                normalization = normalize_edges(graph)
                export_path = self.root / 'synthetic-export.json'
                export_path.write_text(json.dumps(graph, ensure_ascii=False), encoding='utf-8')
                exported = export_path.read_text(encoding='utf-8')

                self.assertNotIn(sentinel, exported,
                                 'Root .state snapshot payload reached export graph')
                self.assertEqual(json.loads(exported), expected)
                self.assertEqual(privacy['nodesRemoved'], len(private_nodes))
                self.assertEqual(privacy['edgesRemoved'], 2 * len(rejected_edges))
                self.assertEqual(privacy['hyperedgesRemoved'], len(rejected_hyperedges))
                self.assertEqual(admission['nodesRemoved'], 0)
                self.assertEqual(normalization['exactDuplicatesRemoved'], 2)
                paths, hashes = self.source_scope(graph)
                self.assertEqual(paths, sorted(public_content))
                self.assertEqual(hashes, [
                    {'path': path, 'sha256': hashlib.sha256(public_content[path]).hexdigest()}
                    for path in sorted(public_content)
                ])

    def test_source_scope_hashes_real_sources_from_every_native_record_collection(self):
        wiki_path = self.policy['entries'][0]['path']
        content = {'./public/app.js': b'export const app = 1;\n',
                   r'.\server\lib.js': b'export const library = 2;\n',
                   '././docs/guide.md': b'# Public structural guide\n',
                   wiki_path: (self.root / wiki_path).read_bytes()}
        self.put('public/app.js', content['./public/app.js'])
        self.put('server/lib.js', content[r'.\server\lib.js'])
        self.put('docs/guide.md', content['././docs/guide.md'])
        graph = {
            'nodes': [{'id': 'wiki', 'source_file': wiki_path}],
            'links': [{'source': 'wiki', 'target': 'external:app',
                       'source_file': './public/app.js'}],
            'edges': [{'source': 'wiki', 'target': 'external:lib',
                       'source_file': r'.\server\lib.js'}],
            'hyperedges': [{'id': 'guide', 'nodes': ['wiki', 'external:app', 'external:lib'],
                            'source_file': '././docs/guide.md'}],
            'metadata': {'label': 'Portable retained scope'},
        }
        original = deepcopy(graph)

        paths, hashes = self.source_scope(graph)

        self.assertEqual(paths, sorted(content))
        self.assertEqual(hashes, [{'path': path,
                                   'sha256': hashlib.sha256(content[path]).hexdigest()}
                                  for path in sorted(content)])
        self.assertEqual(graph, original)

    def test_source_scope_rejects_operational_and_foreign_paths_in_every_collection(self):
        self.put('data/private.json', '{"private":"fixture"}\n')
        self.put('ops/session.json', '{"session":"fixture"}\n')
        self.put('.env', 'PRIVATE_FIXTURE=value\n')
        for alias in ('Data/private.json', 'Ops/session.json', '.ENV'):
            self.put(alias, 'Case-aliased private fixture\n')
        for path in ('./data/private.json', r'.\data\private.json',
                     '././ops/session.json', './.env', '../escape.md',
                     './Data/private.json', r'.\Ops\session.json', './.ENV',
                     'Z:/capture.md', r'Z:\capture.md', 'Z:relative.md',
                     r'\\outside\share\capture.md'):
            for field in ('nodes', 'links', 'edges', 'hyperedges'):
                with self.subTest(path=path, field=field):
                    graph = {'nodes': [{'id': 'wiki',
                                        'source_file': self.policy['entries'][0]['path']}],
                             'links': [], 'edges': [], 'hyperedges': []}
                    if field == 'nodes':
                        record = {'id': 'unsafe', 'source_file': path}
                    elif field == 'hyperedges':
                        record = {'nodes': ['wiki'], 'source_file': path}
                    else:
                        record = {'source': 'wiki', 'target': 'wiki', 'source_file': path}
                    graph[field].append(record)
                    original = deepcopy(graph)

                    with self.assertRaises(ValueError):
                        self.source_scope(graph)

                    self.assertEqual(graph, original)

    def test_source_scope_rejects_real_public_directory_alias_to_raw_capture(self):
        directory = self.root / 'docs'
        directory.mkdir()
        alias = directory / 'capture-alias'
        target = self.root / 'llm-wiki/raw'
        try:
            alias.symlink_to(target, target_is_directory=True)
        except OSError:
            if os.name != 'nt':
                raise
            junction = subprocess.run(
                ['cmd.exe', '/c', 'mklink', '/J', str(alias), str(target)],
                cwd=self.root, capture_output=True, timeout=30)
            self.assertEqual(junction.returncode, 0,
                             'Real symlink and junction setup unavailable: ' +
                             repr(junction.stdout + junction.stderr))
        alias_path = 'docs/capture-alias/sources/capture.md'
        self.assertEqual((self.root / alias_path).read_bytes(),
                         (self.root / self.raw_path).read_bytes())
        graph = {'nodes': [{'id': 'alias', 'source_file': alias_path}], 'links': []}
        original = deepcopy(graph)

        admission = exclude_unadmitted_wiki(graph, self.admission)

        self.assertEqual(admission['nodesRemoved'], 0)
        with self.assertRaisesRegex(ValueError, 'Symlink|reparse'):
            self.source_scope(graph)
        self.assertEqual(graph, original)

    def test_native_process_contract_confines_relative_manifest_and_preserves_existing_manifest(self):
        previous_manifest = b'{"manifest":"previous root extraction"}\n'
        self.put('graphify-out/manifest.json', previous_manifest)
        self.put('native_boundary.py', dedent('''
            import json
            import os
            from pathlib import Path
            import sys

            root = Path(__file__).resolve().parent
            arguments = sys.argv[1:]
            if arguments == ['--version']:
                print('Graphify 0.8.39 filesystem-boundary fixture; no extraction')
            elif arguments[0] == 'update':
                if Path(arguments[1]).resolve() != root:
                    raise SystemExit('Native update must target the repository, not its staging cwd')
                output = Path(os.environ['GRAPHIFY_OUT'])
                output.mkdir(parents=True, exist_ok=True)
                graph = {
                    'nodes': [
                        {'id': 'reviewed', 'source_file': 'llm-wiki/wiki/sources/reviewed.md'},
                        {'id': 'raw', 'source_file': 'llm-wiki/raw/sources/capture.md'},
                    ],
                    'links': [{'source': 'reviewed', 'target': 'raw'}],
                    'metadata': {'nativeFixture': 'filesystem-boundary-only'},
                }
                (output / 'graph.json').write_text(json.dumps(graph), encoding='utf-8')
                manifest = Path('graphify-out/manifest.json')
                manifest.parent.mkdir(parents=True, exist_ok=True)
                manifest.write_text(json.dumps({'files': [node['source_file']
                                                          for node in graph['nodes']]}),
                                    encoding='utf-8')
            elif arguments[0] == 'tree':
                source_root = arguments[arguments.index('--root') + 1]
                if source_root != '.':
                    raise SystemExit('Native tree needs a relative lexical base for portable paths')
                graph_path = Path(arguments[arguments.index('--graph') + 1])
                graph = json.loads(graph_path.read_text(encoding='utf-8'))
                if [node['id'] for node in graph['nodes']] != ['reviewed'] or graph['links']:
                    raise SystemExit('Tree received unfiltered graph input')
                output = Path(arguments[arguments.index('--output') + 1])
                output.write_text('<html>Filtered filesystem-boundary fixture</html>',
                                  encoding='utf-8')
            else:
                raise SystemExit('Unexpected native boundary command')
        '''))
        actual_run = subprocess.run
        native_calls = []
        native_manifests = []

        def run_at_process_boundary(command, *arguments, **options):
            if command[0] != 'graphify':
                return actual_run(command, *arguments, **options)
            native_calls.append({'command': list(command), 'cwd': Path(options['cwd']),
                                 'output': Path(options['env']['GRAPHIFY_OUT'])})
            result = actual_run([sys.executable, str(self.root / 'native_boundary.py'),
                                 *command[1:]], *arguments, **options)
            if command[1] == 'update' and result.returncode == 0:
                manifest = Path(options['cwd']) / 'graphify-out/manifest.json'
                native_manifests.append((manifest, manifest.read_bytes()))
            return result

        with patch.object(subprocess, 'run', new=run_at_process_boundary), \
                patch.object(sys, 'argv', [str(self.root / '.graphify/refresh.py')]):
            self.refresh['main']()

        self.assertEqual([call['command'][1] for call in native_calls],
                         ['--version', 'update', 'tree'])
        for call in native_calls:
            self.assertTrue(call['cwd'].is_relative_to(self.root / '.graphify'), call)
            self.assertNotEqual(call['cwd'], self.root / '.graphify')
            self.assertEqual(call['output'], call['cwd'])
        self.assertEqual(Path(native_calls[1]['command'][2]).resolve(), self.root.resolve())
        tree_command = native_calls[2]['command']
        self.assertEqual(tree_command[tree_command.index('--root') + 1], '.')
        self.assertEqual(len(native_manifests), 1)
        self.assertTrue(native_manifests[0][0].is_relative_to(native_calls[1]['cwd']))
        self.assertIn(self.raw_path, json.loads(native_manifests[0][1])['files'])
        self.assertEqual((self.root / 'graphify-out/manifest.json').read_bytes(), previous_manifest)
        graph_bytes = (self.root / '.graphify/graph.json').read_bytes()
        graph = json.loads(graph_bytes)
        self.assertEqual([node['id'] for node in graph['nodes']], ['reviewed'])
        self.assertEqual(graph['metadata'], {'nativeFixture': 'filesystem-boundary-only'})
        receipt = json.loads((self.root / '.graphify/verification.json').read_bytes())
        self.assertTrue(receipt['ok'], receipt)
        self.assertEqual(receipt['graphSha256'], hashlib.sha256(graph_bytes).hexdigest())

    def test_fresh_native_staging_replaces_larger_generation_only_after_validation(self):
        authored_path = self.policy['entries'][0]['path']
        self.put('public/app.js', 'export const app = 1;\n')
        for name in ('retired-a', 'retired-b'):
            self.put('public/' + name + '.js', 'export const retired = true;\n')
        expected = {
            'nodes': [{'id': 'app', 'source_file': 'public/app.js'},
                      {'id': 'reviewed', 'source_file': authored_path}],
            'links': [{'source': 'app', 'target': 'reviewed', 'source_file': 'public/app.js',
                       'metadata': {'kind': 'documents', 'line': 2}}],
            'edges': [{'source': 'reviewed', 'target': 'app', 'source_file': authored_path,
                       'metadata': {'kind': 'implementation', 'line': 3}}],
            'hyperedges': [{'id': 'reviewed-group', 'nodes': ['app', 'reviewed'],
                            'source_file': authored_path}],
            'metadata': {'nativeFixture': 'fresh-staging-shrink-only'},
        }
        previous = deepcopy(expected)
        previous['nodes'].extend([
            {'id': name, 'source_file': 'public/' + name + '.js'}
            for name in ('retired-a', 'retired-b')
        ])
        previous['links'].append({'source': 'retired-a', 'target': 'retired-b',
                                  'source_file': 'public/retired-a.js'})
        previous['metadata'] = {'nativeFixture': 'previous-larger-generation'}
        previous_paths = sorted(node['source_file'] for node in previous['nodes'])
        previous_hashes = [
            {'path': path, 'sha256': hashlib.sha256((self.root / path).read_bytes()).hexdigest()}
            for path in previous_paths
        ]
        previous_exports = {
            'graph.json': json.dumps(previous).encode('utf-8'),
            'graph.html': b'<html>Previous fixture: 4 nodes, 3 edges</html>\n',
            'scope.json': json.dumps({'files': previous_paths,
                                      'sourceFileHashes': previous_hashes}).encode('utf-8'),
            'GRAPH_REPORT.md': b'# Previous fixture\n4 nodes, 3 edges\n',
        }
        previous_exports['verification.json'] = json.dumps({
            'ok': True, 'nodes': 4, 'edges': 3,
            'graphSha256': hashlib.sha256(previous_exports['graph.json']).hexdigest(),
            'sourceFiles': previous_paths, 'sourceFileHashes': previous_hashes,
        }).encode('utf-8')
        for name, content in previous_exports.items():
            self.put('.graphify/' + name, content)
        for name in ('retired-a', 'retired-b'):
            (self.root / ('public/' + name + '.js')).unlink()
        candidate = deepcopy(expected)
        candidate['nodes'].append({'id': 'raw', 'source_file': self.raw_path,
                                   'label': 'PRIVATE_FRESH_STAGING_FIXTURE'})
        candidate['links'].append({'source': 'app', 'target': 'raw'})
        candidate['edges'].append({'source': 'raw', 'target': 'reviewed'})
        self.put('native-candidate.json', json.dumps(candidate))
        self.put('native-expected.json', json.dumps(expected))
        self.put('native_fresh_boundary.py', dedent('''
            import json
            import os
            from pathlib import Path
            import sys

            root = Path(__file__).resolve().parent
            arguments = sys.argv[1:]
            if arguments == ['--version']:
                print('Offline native-process fixture; fresh staging shrink contract only')
            elif arguments == ['update', str(root), '--no-cluster']:
                output = Path(os.environ['GRAPHIFY_OUT'])
                graph_path = output / 'graph.json'
                if graph_path.exists():
                    raise SystemExit('Fresh staging inherited an obsolete public graph; '
                                     'a smaller valid corpus must not reuse the old generation')
                graph_path.write_bytes((root / 'native-candidate.json').read_bytes())
            elif arguments[0] == 'tree':
                graph_path = Path(arguments[arguments.index('--graph') + 1])
                expected = json.loads((root / 'native-expected.json').read_bytes())
                if json.loads(graph_path.read_bytes()) != expected:
                    raise SystemExit('Tree received stale or unfiltered graph records')
                output = Path(arguments[arguments.index('--output') + 1])
                output.write_text('<html>Fresh filtered fixture: 2 nodes, 2 edges</html>',
                                  encoding='utf-8')
            else:
                raise SystemExit('Unexpected native fresh-staging fixture invocation')
        '''))
        actual_run = subprocess.run
        native_failures = []

        def run_at_process_boundary(command, *arguments, **options):
            if command[0] != 'graphify':
                return actual_run(command, *arguments, **options)
            for name, content in previous_exports.items():
                self.assertEqual((self.root / '.graphify' / name).read_bytes(), content,
                                 'Unvalidated extraction replaced prior ' + name)
            result = actual_run([sys.executable, str(self.root / 'native_fresh_boundary.py'),
                                 *command[1:]], *arguments, **options)
            for name, content in previous_exports.items():
                self.assertEqual((self.root / '.graphify' / name).read_bytes(), content,
                                 'Native processing replaced prior ' + name)
            if result.returncode:
                native_failures.append(result.stdout + result.stderr)
            return result

        with patch.object(subprocess, 'run', new=run_at_process_boundary), \
                patch.object(sys, 'argv', [str(self.root / '.graphify/refresh.py')]):
            try:
                self.refresh['main']()
            except SystemExit as error:
                self.fail('A valid smaller generation must publish from fresh staging: '
                          + str(error) + '\n' + '\n'.join(native_failures))

        graph_bytes = (self.root / '.graphify/graph.json').read_bytes()
        self.assertEqual(json.loads(graph_bytes), expected)
        self.assertEqual((self.root / '.graphify/graph.html').read_text(encoding='utf-8'),
                         '<html>Fresh filtered fixture: 2 nodes, 2 edges</html>')
        paths = sorted(node['source_file'] for node in expected['nodes'])
        hashes = [{'path': path, 'sha256': hashlib.sha256((self.root / path).read_bytes()).hexdigest()}
                  for path in paths]
        scope = json.loads((self.root / '.graphify/scope.json').read_bytes())
        self.assertEqual(scope['files'], paths)
        self.assertEqual(scope['sourceFileHashes'], hashes)
        receipt = json.loads((self.root / '.graphify/verification.json').read_bytes())
        self.assertTrue(receipt['ok'], receipt)
        self.assertEqual((receipt['nodes'], receipt['edges']), (2, 2))
        self.assertEqual(receipt['nativeUnfilteredCounts'], {'nodes': 3, 'edges': 4})
        self.assertEqual(receipt['graphSha256'], hashlib.sha256(graph_bytes).hexdigest())
        self.assertEqual(receipt['sourceFiles'], paths)
        self.assertEqual(receipt['sourceFileHashes'], hashes)
        self.assertEqual(receipt['wikiAdmissionAudit']['nodesRemoved'], 1)
        self.assertEqual(receipt['wikiAdmissionAudit']['edgesRemoved'], 2)
        self.assertIn('**2 nodes, 2 edges**',
                      (self.root / '.graphify/GRAPH_REPORT.md').read_text(encoding='utf-8'))

    def test_real_cli_policy_failures_block_refresh_before_replacing_any_export(self):
        source_path = self.policy['entries'][0]['path']
        restored_paths = ('harness/knowledge-policy.json', source_path, 'llm-wiki/index.md')
        originals = {path: (self.root / path).read_bytes() for path in restored_paths}
        exports = {'graph.json': b'{"nodes":[{"id":"previous"}],"links":[]}\n',
                   'graph.html': b'<html>Previous filtered export</html>\n',
                   'scope.json': b'{"files":["public/app.js"]}\n',
                   'GRAPH_REPORT.md': b'# Previous filtered graph report\n'}
        exports['verification.json'] = json.dumps({
            'ok': True, 'generation': 'previous',
            'graphSha256': hashlib.sha256(exports['graph.json']).hexdigest(),
        }).encode('utf-8')
        for name, content in exports.items():
            self.put('.graphify/' + name, content)
        cases = (
            ('missing-policy', None),
            ('invalid-json', 'invalid-json'),
            ('invalid-schema', 'invalid-policy'),
            ('drifted-reviewed-hash', 'source-hash-mismatch'),
            ('drifted-source-bytes', 'source-hash-mismatch'),
            ('drifted-policy-navigation', 'index-inconsistent'),
        )
        for mutation, error_code in cases:
            with self.subTest(mutation=mutation):
                for path, content in originals.items():
                    self.put(path, content)
                load_knowledge_admission(root=self.root)
                policy = deepcopy(self.policy)
                if mutation == 'missing-policy':
                    (self.root / 'harness/knowledge-policy.json').unlink()
                elif mutation == 'invalid-json':
                    self.put('harness/knowledge-policy.json', '{')
                elif mutation == 'invalid-schema':
                    policy['schema'] = 'not-a-knowledge-policy'
                    self.save_policy(policy)
                elif mutation == 'drifted-reviewed-hash':
                    policy['entries'][0]['sha256'] = '0' * 64
                    self.save_policy(policy)
                elif mutation == 'drifted-source-bytes':
                    self.put(source_path, originals[source_path] + b'Unreviewed new claim.\n')
                elif mutation == 'drifted-policy-navigation':
                    policy['admission'] = 'Reviewed policy change without regenerated navigation.'
                    self.save_policy(policy)

                result, status = self.knowledge('status')
                self.assertNotEqual(result.returncode, 0, status)
                self.assertFalse(status['ok'], status)
                self.assertTrue(status['errors'], status)
                if error_code is not None:
                    self.assertIn(error_code, {error['code'] for error in status['errors']})
                with self.assertRaises(ValueError):
                    load_knowledge_admission(root=self.root)
                failure_root = self.root / 'data/harness-audit'
                prior_failures = {path: path.read_bytes()
                                  for path in failure_root.glob('graphify-refresh-failure-*.json')}
                refreshed = subprocess.run(
                    [sys.executable, str(self.root / '.graphify/refresh.py')],
                    cwd=self.root, capture_output=True, text=True,
                    encoding='utf-8', timeout=30)

                self.assertNotEqual(refreshed.returncode, 0, refreshed.stdout + refreshed.stderr)
                new_failures = set(failure_root.glob('graphify-refresh-failure-*.json')) - set(prior_failures)
                self.assertEqual(len(new_failures), 1)
                receipt = json.loads(new_failures.pop().read_bytes())
                for path, content in prior_failures.items():
                    self.assertEqual(path.read_bytes(), content)
                self.assertFalse(receipt['ok'], receipt)
                self.assertEqual(receipt['commands'], [],
                                 'Failed admission must stop before any native Graphify command')
                self.assertIn('admission', receipt['error'].lower())
                for name, content in exports.items():
                    self.assertEqual((self.root / '.graphify' / name).read_bytes(), content,
                                     'Failed admission must preserve prior ' + name)


class PublicationBoundaryTest(unittest.TestCase):
    artifact_names = ('graph.json', 'graph.html', 'scope.json', 'GRAPH_REPORT.md', 'verification.json')

    def setUp(self):
        directory = tempfile.TemporaryDirectory(prefix='frameforge-graph-publication-')
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.output = self.root / '.graphify'
        self.output.mkdir()
        shutil.copyfile(ROOT / '.graphify/refresh.py', self.output / 'refresh.py')
        self.refresh = runpy.run_path(str(self.output / 'refresh.py'))
        self.staging = self.root / 'candidate'
        self.staging.mkdir()
        self.recovery = self.root / 'data/harness-audit/graphify-publication'
        self.previous = self.generation('previous')
        self.candidate = self.generation('candidate')
        self.write_generation(self.output, self.previous)
        self.write_generation(self.staging, self.candidate)

    def generation(self, label):
        graph = json.dumps({'nodes': [{'id': label}], 'links': []}).encode('utf-8')
        return {
            'graph.json': graph,
            'graph.html': ('<html>' + label + '</html>\n').encode('utf-8'),
            'scope.json': json.dumps({'generation': label, 'files': []}).encode('utf-8'),
            'GRAPH_REPORT.md': ('# ' + label + ' graph\n').encode('utf-8'),
            'verification.json': json.dumps({'ok': True, 'generation': label,
                                              'graphSha256': hashlib.sha256(graph).hexdigest()})
                                 .encode('utf-8'),
        }

    def write_generation(self, directory, generation):
        for name, content in generation.items():
            (directory / name).write_bytes(content)

    def assert_generation(self, generation):
        for name, content in generation.items():
            self.assertEqual((self.output / name).read_bytes(), content, name)

    def publish(self):
        return self.refresh['publish_artifacts'](
            self.staging, output=self.output, recovery_root=self.recovery)

    def fail_publication(self, name, fail_rollback=False):
        actual_replace = Path.replace
        events = []

        def replace_with_filesystem_failure(source, destination):
            destination = Path(destination)
            if source.parent == self.staging and destination == self.output / name:
                for preceding in self.artifact_names[:self.artifact_names.index(name)]:
                    self.assertEqual((self.output / preceding).read_bytes(),
                                     self.candidate[preceding], preceding)
                events.append('publish:' + name)
                raise PermissionError('injected publication replacement failure: ' + name)
            if (fail_rollback and destination == self.output / 'graph.json'
                    and source.name == '.graph.json.rollback'):
                events.append('rollback:graph.json')
                raise PermissionError('injected rollback replacement failure')
            return actual_replace(source, destination)

        with patch.object(Path, 'replace', new=replace_with_filesystem_failure):
            with self.assertRaisesRegex(ValueError, 'Publication failed') as failure:
                self.publish()
        return failure.exception, events

    def test_publication_success_keeps_graph_and_receipt_in_the_same_generation(self):
        result = self.publish()

        self.assertTrue(result['ok'], result)
        self.assert_generation(self.candidate)
        receipt = json.loads((self.output / 'verification.json').read_bytes())
        self.assertEqual(receipt['graphSha256'],
                         hashlib.sha256((self.output / 'graph.json').read_bytes()).hexdigest())
        self.assertFalse((self.output / '.refresh-publication.lock').exists())

    def test_failure_after_first_replacement_restores_five_files_and_allows_retry(self):
        _, events = self.fail_publication('graph.html')

        self.assertEqual(events, ['publish:graph.html'])
        self.assert_generation(self.previous)
        self.assertFalse((self.output / '.refresh-publication.lock').exists())
        self.write_generation(self.staging, self.candidate)

        result = self.publish()

        self.assertTrue(result['ok'], result)
        self.assert_generation(self.candidate)

    def test_committed_journal_sync_failure_restores_previous_generation_before_claiming_preservation(self):
        production_globals = self.refresh['publish_artifacts'].__globals__
        actual_sync = production_globals['sync_directory']
        injected = []

        def fail_committed_directory_sync(path):
            path = Path(path)
            journal = path / 'journal.json'
            if path.parent == self.recovery and journal.is_file() and not injected:
                state = json.loads(journal.read_bytes())
                if state['state'] == 'committed':
                    self.assert_generation(self.candidate)
                    self.assertTrue((self.output / '.refresh-publication.lock').exists())
                    injected.append(path)
                    raise OSError('Injected committed-journal directory-sync seam failure')
            return actual_sync(path)

        with patch.dict(production_globals, {'sync_directory': fail_committed_directory_sync}):
            with self.assertRaisesRegex(ValueError, 'Publication failed') as failure:
                self.publish()

        self.assertEqual(len(injected), 1,
                         'The fault must occur after the real committed journal becomes visible')
        self.assertIn('previous artifact bytes and receipt were preserved', str(failure.exception))
        self.assert_generation(self.previous)
        self.assertFalse((self.output / '.refresh-publication.lock').exists())

    def test_receipt_replacement_failure_rolls_back_all_four_preceding_exports(self):
        _, events = self.fail_publication('verification.json')

        self.assertEqual(events, ['publish:verification.json'])
        self.assert_generation(self.previous)
        self.assertFalse((self.output / '.refresh-publication.lock').exists())

    def test_first_generation_failure_restores_prior_absence_including_receipt(self):
        for name in self.artifact_names:
            (self.output / name).unlink()

        _, events = self.fail_publication('graph.html')

        self.assertEqual(events, ['publish:graph.html'])
        for name in self.artifact_names:
            self.assertFalse((self.output / name).exists(), name)
        self.assertFalse((self.output / '.refresh-publication.lock').exists())

    def test_incomplete_rollback_is_locked_hash_checked_and_recoverable_by_public_cli(self):
        failure, events = self.fail_publication('graph.html', fail_rollback=True)

        self.assertEqual(events, ['publish:graph.html', 'rollback:graph.json'])
        self.assertIn('--recover-publication', str(failure))
        lock = self.output / '.refresh-publication.lock'
        self.assertTrue(lock.is_file())
        transaction = Path(lock.read_text(encoding='utf-8').strip())
        self.assertTrue(transaction.is_relative_to(self.recovery))
        self.assertIn(str(transaction), str(failure))
        journal = json.loads((transaction / 'journal.json').read_bytes())
        self.assertEqual(journal['state'], 'rollback-incomplete')
        self.assertIn('graph.json', journal['failedRestores'])
        for item in journal['prior']:
            self.assertEqual(item['sha256'], hashlib.sha256(self.previous[item['name']]).hexdigest())
            self.assertEqual((transaction / item['name']).read_bytes(), self.previous[item['name']])
        partial = {name: (self.output / name).read_bytes() for name in self.artifact_names}
        self.assertEqual(partial['verification.json'], self.previous['verification.json'])
        self.assertNotEqual(json.loads(partial['verification.json'])['graphSha256'],
                            hashlib.sha256(partial['graph.json']).hexdigest(),
                            'An interrupted set must not be mistaken for a verified fresh generation')
        self.write_generation(self.staging, self.candidate)
        with self.assertRaisesRegex(ValueError, 'locked'):
            self.publish()
        self.assert_generation(partial)
        (transaction / 'graph.json').write_bytes(b'Corrupted recovery snapshot fixture')

        with self.assertRaisesRegex(ValueError, 'snapshot hash mismatch'):
            self.refresh['recover_publication'](transaction, output=self.output)

        self.assert_generation(partial)
        self.assertTrue(lock.exists())
        (transaction / 'graph.json').write_bytes(self.previous['graph.json'])
        recovered = subprocess.run(
            [sys.executable, str(self.output / 'refresh.py'), '--recover-publication', str(transaction)],
            cwd=self.root, capture_output=True, text=True, encoding='utf-8', timeout=30)

        self.assertEqual(recovered.returncode, 0, recovered.stdout + recovered.stderr)
        self.assert_generation(self.previous)
        self.assertFalse(lock.exists())
        self.assertFalse(transaction.exists())


if __name__ == '__main__':
    unittest.main()
