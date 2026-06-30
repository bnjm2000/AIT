import os
import tempfile
import unittest
import uuid

from data_manager import ConcurrentDataChangeError
from models import Client, Container, Event, InventoryItem, LogEntry, User


class PostgresDataManagerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.base_dsn = os.environ.get('TEST_DATABASE_URL', '').strip()
        if not cls.base_dsn:
            raise unittest.SkipTest('TEST_DATABASE_URL is not configured')

        import psycopg
        from psycopg import sql
        from psycopg.conninfo import make_conninfo

        cls.psycopg = psycopg
        cls.sql = sql
        cls.schema = f"aim_test_{uuid.uuid4().hex}"
        with psycopg.connect(cls.base_dsn) as connection:
            connection.execute(
                sql.SQL("CREATE SCHEMA {}").format(sql.Identifier(cls.schema))
            )
        cls.dsn = make_conninfo(
            cls.base_dsn,
            options=f'-c search_path={cls.schema}',
        )

    @classmethod
    def tearDownClass(cls):
        from postgres_data_manager import close_postgres_pool

        close_postgres_pool(cls.dsn)
        with cls.psycopg.connect(cls.base_dsn) as connection:
            connection.execute(
                cls.sql.SQL("DROP SCHEMA {} CASCADE").format(
                    cls.sql.Identifier(cls.schema)
                )
            )

    def setUp(self):
        from postgres_data_manager import PostgresDataManager

        self.tempdir = tempfile.TemporaryDirectory()
        self.company_code = f"T{uuid.uuid4().hex[:10].upper()}"
        self.manager = PostgresDataManager(
            self.dsn,
            self.company_code,
            self.tempdir.name,
            'Integration Test Company',
        )
        self.manager.setup_data_folder()
        self.manager.check_and_initialize_files()
        self.manager.load_all_data()

    def tearDown(self):
        self.manager.delete_company_data()
        self.tempdir.cleanup()

    def test_round_trip_all_primary_record_types(self):
        from postgres_data_manager import PostgresDataManager

        self.manager.users = {
            'admin': User(
                'admin',
                'hash',
                'salt',
                True,
                True,
                last_online='2026-06-30T18:00:00+08:00',
            ),
        }
        self.manager.save_users()
        self.manager.inventory = {
            'A#01': InventoryItem(
                'A#01',
                'Brand',
                'Model',
                'SN-1',
                'Description',
                False,
                [],
                'AX',
                'Store',
                '',
            ),
        }
        self.manager.save_inventory()
        self.manager.containers = {
            'CASE-1': Container('CASE-1', ['A#01'], 'CASE-SN'),
        }
        self.manager.save_containers()
        event = Event(
            1,
            'Test Event',
            '20260601',
            '20260602',
            [],
            prepared_items=['A#01'],
        )
        self.manager.events[1] = event
        self.manager.save_event(event)
        self.manager.clients = {
            'Client': Client('Client', 'Company'),
        }
        self.manager.save_clients()
        self.manager.save_departments({
            'AX': {
                'code': 'AX',
                'name': 'Audio',
                'color': '#FFFFFF',
                'textColor': '#111827',
            },
        })
        self.manager.logs.append(
            LogEntry('2026/06/01 10:00:00', 'admin', 'Integration test action')
        )
        self.manager.save_logs()

        reloaded = PostgresDataManager(
            self.dsn,
            self.company_code,
            self.tempdir.name,
            'Integration Test Company',
        )
        reloaded.load_all_data()

        self.assertEqual(
            reloaded.users['admin'].last_online,
            '2026-06-30T18:00:00+08:00',
        )
        self.assertEqual(reloaded.inventory['A#01'].serial_number, 'SN-1')
        self.assertEqual(reloaded.containers['CASE-1'].serial_number, 'CASE-SN')
        self.assertEqual(reloaded.events[1].prepared_items, ['A#01'])
        self.assertEqual(reloaded.clients['Client'].company, 'Company')
        self.assertEqual(reloaded.load_departments()['AX']['name'], 'Audio')
        self.assertEqual(reloaded.logs[-1].action, 'Integration test action')

    def test_stale_write_is_rejected(self):
        from postgres_data_manager import PostgresDataManager

        self.manager.inventory = {
            'A#01': InventoryItem(
                'A#01',
                'Brand',
                'Model',
                'SN-1',
                'Description',
                False,
                [],
                'AX',
            ),
        }
        self.manager.save_inventory()

        first = PostgresDataManager(
            self.dsn,
            self.company_code,
            self.tempdir.name,
        )
        second = PostgresDataManager(
            self.dsn,
            self.company_code,
            self.tempdir.name,
        )
        first.load_all_data()
        second.load_all_data()

        first.inventory['A#01'].notes = 'first writer'
        first.save_inventory()
        second.inventory['A#01'].notes = 'stale writer'

        with self.assertRaises(ConcurrentDataChangeError):
            second.save_inventory()
        self.assertEqual(second.inventory['A#01'].notes, 'first writer')


if __name__ == '__main__':
    unittest.main()
