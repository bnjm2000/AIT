import unittest

from event_concurrency import EventMergeConflict, merge_event_payloads


class EventConcurrencyTests(unittest.TestCase):
    def test_independent_scalar_and_requirement_edits_merge(self):
        base = {
            'name': 'Show',
            'notes': '',
            'preparedItems': ['[MODEL]AX|Shure|SM58|2|Microphone'],
        }
        current = {
            **base,
            'notes': 'Loading dock access',
        }
        desired = {
            **base,
            'preparedItems': ['[MODEL]AX|Shure|SM58|3|Microphone'],
        }

        merged = merge_event_payloads(base, current, desired)

        self.assertEqual(merged['notes'], 'Loading dock access')
        self.assertEqual(
            merged['preparedItems'],
            ['[MODEL]AX|Shure|SM58|3|Microphone'],
        )

    def test_different_room_lines_merge(self):
        base = {
            'subprojects': [{
                'id': 'main',
                'name': 'Main Room',
                'items': [
                    {'lineId': 'a', 'quantity': 1, 'model': 'SM58'},
                    {'lineId': 'b', 'quantity': 1, 'model': 'SM81'},
                ],
            }],
        }
        current = {
            'subprojects': [{
                'id': 'main',
                'name': 'Main Room',
                'items': [
                    {'lineId': 'a', 'quantity': 2, 'model': 'SM58'},
                    {'lineId': 'b', 'quantity': 1, 'model': 'SM81'},
                ],
            }],
        }
        desired = {
            'subprojects': [{
                'id': 'main',
                'name': 'Main Room',
                'items': [
                    {'lineId': 'a', 'quantity': 1, 'model': 'SM58'},
                    {'lineId': 'b', 'quantity': 3, 'model': 'SM81'},
                ],
            }],
        }

        merged = merge_event_payloads(base, current, desired)
        quantities = {
            row['lineId']: row['quantity']
            for row in merged['subprojects'][0]['items']
        }
        self.assertEqual(quantities, {'a': 2, 'b': 3})

    def test_same_requirement_quantity_conflicts(self):
        base = {'preparedItems': ['[MODEL]AX|Shure|SM58|2|Microphone']}
        current = {'preparedItems': ['[MODEL]AX|Shure|SM58|3|Microphone']}
        desired = {'preparedItems': ['[MODEL]AX|Shure|SM58|4|Microphone']}

        with self.assertRaises(EventMergeConflict):
            merge_event_payloads(base, current, desired)

    def test_same_model_with_different_descriptions_merges_independently(self):
        base = {
            'preparedItems': [
                '[MODEL]AX|Shure|SM58|1|Black microphone',
                '[MODEL]AX|Shure|SM58|1|Silver microphone',
            ],
        }
        current = {
            'preparedItems': [
                '[MODEL]AX|Shure|SM58|2|Black microphone',
                '[MODEL]AX|Shure|SM58|1|Silver microphone',
            ],
        }
        desired = {
            'preparedItems': [
                '[MODEL]AX|Shure|SM58|1|Black microphone',
                '[MODEL]AX|Shure|SM58|3|Silver microphone',
            ],
        }

        merged = merge_event_payloads(base, current, desired)

        self.assertEqual(merged['preparedItems'], [
            '[MODEL]AX|Shure|SM58|2|Black microphone',
            '[MODEL]AX|Shure|SM58|3|Silver microphone',
        ])

    def test_concurrent_distinct_assignments_are_retained(self):
        base = {'actuallyPrepared': []}
        current = {'actuallyPrepared': ['SM58#01']}
        desired = {'actuallyPrepared': ['SM58#02']}

        merged = merge_event_payloads(base, current, desired)

        self.assertEqual(merged['actuallyPrepared'], ['SM58#01', 'SM58#02'])


if __name__ == '__main__':
    unittest.main()
