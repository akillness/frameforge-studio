"""Offline regression for exact-record normalization without running Graphify."""
import ast
import json
from pathlib import Path
import unittest

source = ast.parse(Path(__file__).with_name('refresh.py').read_text(encoding='utf-8'))
function = next(node for node in source.body if isinstance(node, ast.FunctionDef)
                and node.name == 'normalize_edges')
namespace = {'json': json}
exec(compile(ast.Module(body=[function], type_ignores=[]), 'refresh.py', 'exec'), namespace)
normalize_edges = namespace['normalize_edges']


class NormalizationTest(unittest.TestCase):
    def test_key_order_duplicates_removed_but_metadata_kept(self):
        first = {'source': 'a', 'target': 'b', 'metadata': {'line': 2, 'kind': 'call'}}
        reordered = {'metadata': {'kind': 'call', 'line': 2}, 'target': 'b', 'source': 'a'}
        different = {'source': 'a', 'target': 'b', 'metadata': {'line': 3, 'kind': 'call'}}
        graph = {'nodes': [{'id': 'a'}], 'links': [first, reordered, different]}
        audit = normalize_edges(graph)
        self.assertEqual(graph['links'], [first, different])
        self.assertEqual(graph['nodes'], [{'id': 'a'}])
        self.assertEqual(audit['exactDuplicatesRemoved'], 1)
        self.assertEqual(normalize_edges(graph)['exactDuplicatesRemoved'], 0)

    def test_edges_field_and_nested_order(self):
        graph = {'edges': [{'a': [1, 2]}, {'a': [2, 1]}, {'a': [1, 2]}]}
        normalize_edges(graph)
        self.assertEqual(graph['edges'], [{'a': [1, 2]}, {'a': [2, 1]}])


def exclude_local_state(graph):
    function = next(node for node in source.body if isinstance(node, ast.FunctionDef)
                    and node.name == 'exclude_checkout_local_state')
    namespace = {}
    exec(compile(ast.Module(body=[function], type_ignores=[]), 'refresh.py', 'exec'), namespace)
    return namespace['exclude_checkout_local_state'](graph)


class SourceBoundaryTest(unittest.TestCase):
    def test_removes_local_nodes_incident_edges_and_local_origin_edges(self):
        canonical = {'source': 'app', 'target': 'lib', 'source_file': 'public/app.js', 'metadata': {'line': 8}}
        graph = {'nodes': [{'id': 'app', 'source_file': 'public/app.js'},
                           {'id': 'private', 'source_file': '.jeo/release.py'},
                           {'id': 'lib', 'source_file': ''},
                           {'id': 'similar', 'source_file': '.jeo-tools/legitimate.py'}],
                 'links': [canonical,
                           {'source': 'private', 'target': 'lib', 'source_file': 'public/app.js'},
                           {'source': 'app', 'target': 'private'},
                           {'source': 'app', 'target': 'lib', 'source_file': '.jeo/release.py'}]}
        audit = exclude_local_state(graph)
        self.assertEqual([node['id'] for node in graph['nodes']], ['app', 'lib', 'similar'])
        self.assertEqual(graph['links'], [canonical])
        self.assertEqual(audit['nodesRemoved'], 1)
        self.assertEqual(audit['edgesRemoved'], 3)

    def test_windows_paths_and_generated_vault_metadata_are_excluded_idempotently(self):
        prefixes = ['.jeo/', '.omc/', '.omx/', 'llm-wiki/.graphify/', 'llm-wiki/.state/']
        graph = {'nodes': [{'id': str(index), 'source_file': (prefix+'local.py').replace('/', chr(92))}
                           for index, prefix in enumerate(prefixes)] +
                          [{'id': 'report', 'source_file': 'llm-wiki/wiki/reports/workspace.md'}],
                 'edges': [{'source': 'report', 'target': str(index)} for index in range(len(prefixes))]}
        audit = exclude_local_state(graph)
        self.assertEqual(graph['nodes'], [{'id': 'report', 'source_file': 'llm-wiki/wiki/reports/workspace.md'}])
        self.assertEqual(graph['edges'], [])
        self.assertEqual(audit['nodesRemoved'], len(prefixes))
        self.assertEqual(exclude_local_state(graph)['nodesRemoved'], 0)
        self.assertEqual(exclude_local_state(graph)['edgesRemoved'], 0)


if __name__ == '__main__':
    unittest.main()
