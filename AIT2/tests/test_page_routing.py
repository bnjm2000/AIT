import os
import tempfile
import unittest

import app as app_module
from data_manager import DataManager
from models import Event, User, hash_password


class PageRoutingTests(unittest.TestCase):
    def setUp(self):
        self.original_manager = app_module.get_default_data_manager()
        self.original_testing = app_module.app.config.get('TESTING')
        self.original_registry_file = app_module.COMPANY_REGISTRY_FILE
        self.original_registry_cache = app_module._company_registry_cache
        self.original_signature = app_module._data_snapshot_signature
        self.tempdir = tempfile.TemporaryDirectory()

        app_module.COMPANY_REGISTRY_FILE = os.path.join(self.tempdir.name, 'Companies.json')
        app_module._company_registry_cache = None
        company = app_module._new_company_record('TEST', 'Routing Test')
        app_module._save_company_registry({
            'defaultCompany': 'TEST',
            'companies': {'TEST': company},
            'userCompanies': {
                'owner': 'TEST', 'manager': 'TEST', 'sales': 'TEST', 'user': 'TEST',
            },
            'superAdmins': ['owner'],
        })

        self.manager = DataManager(self.tempdir.name)
        self.manager.setup_data_folder()
        self.manager.users = {
            'owner': self.make_user('owner', 'owner', True),
            'manager': self.make_user('manager', 'manager', False),
            'sales': self.make_user('sales', 'user', True),
            'user': self.make_user('user', 'user', False),
        }
        self.manager.events = {
            41: Event(41, 'Deep Link Event', '20260715', '20260716', [])
        }
        self.manager.save_users()
        app_module.app.config['TESTING'] = True
        app_module.set_data_manager_for_testing(self.manager)
        self.client = app_module.app.test_client()

    def tearDown(self):
        app_module.clear_test_data_manager(self.original_manager)
        app_module.app.config['TESTING'] = self.original_testing
        app_module.COMPANY_REGISTRY_FILE = self.original_registry_file
        app_module._company_registry_cache = self.original_registry_cache
        app_module._data_snapshot_signature = self.original_signature
        self.tempdir.cleanup()

    @staticmethod
    def make_user(username, role, sales):
        return User(
            username, hash_password('pw', username), username,
            role in {'owner', 'admin', 'manager'}, True,
            role=role, has_sales_access=sales,
        )

    def login(self, username):
        user = self.manager.users[username]
        with self.client.session_transaction() as session:
            session.clear()
            session['user'] = username
            session['role'] = user.role
            session['is_admin'] = user.is_admin
            session['is_super_admin'] = username == 'owner'
            session['has_sales_access'] = user.has_sales_access
            session['is_active'] = True
            session['company_code'] = 'TEST'

    def test_named_pages_require_authentication(self):
        response = self.client.get('/prepare')
        self.assertEqual(response.status_code, 302)
        self.assertTrue(response.headers['Location'].endswith('/login'))

    def test_direct_routes_enforce_role_permissions(self):
        self.login('user')
        self.assertEqual(self.client.get('/prepare').status_code, 200)
        for path in ('/plan', '/quotations', '/companies'):
            response = self.client.get(path)
            self.assertEqual(response.status_code, 302, path)
            self.assertTrue(response.headers['Location'].endswith('/events'), path)

        self.login('manager')
        self.assertEqual(self.client.get('/plan').status_code, 200)
        self.assertEqual(self.client.get('/company-details').status_code, 200)
        self.assertEqual(self.client.get('/quotations').status_code, 302)

        self.login('sales')
        self.assertEqual(self.client.get('/quotations').status_code, 200)
        self.assertEqual(self.client.get('/profit-loss').status_code, 200)
        self.assertEqual(self.client.get('/plan').status_code, 302)

        self.login('owner')
        self.assertEqual(self.client.get('/companies').status_code, 200)
        self.assertEqual(self.client.get('/quotations').status_code, 200)

    def test_deep_link_selects_workspace_and_root_redirects(self):
        self.login('owner')
        response = self.client.get('/prepare')
        self.assertEqual(response.status_code, 200)
        self.assertIn('window.__INITIAL_APP_SECTION__ = "prepare-new"', response.get_data(as_text=True))

        root = self.client.get('/')
        self.assertEqual(root.status_code, 302)
        self.assertTrue(root.headers['Location'].endswith('/events'))

    def test_record_deep_links_restore_authorised_workspaces(self):
        self.login('owner')
        quotation = self.client.get('/quotations/quote-123')
        event_overview = self.client.get('/events/41')
        delivery_order = self.client.get('/delivery-order/41')
        packing_list = self.client.get('/packing-list/41')

        self.assertEqual(quotation.status_code, 200)
        self.assertIn('window.__INITIAL_APP_SECTION__ = "quotations"', quotation.get_data(as_text=True))
        self.assertEqual(event_overview.status_code, 200)
        self.assertIn('window.__INITIAL_APP_SECTION__ = "events"', event_overview.get_data(as_text=True))
        self.assertEqual(delivery_order.status_code, 200)
        self.assertIn('window.__INITIAL_APP_SECTION__ = "delivery-order"', delivery_order.get_data(as_text=True))
        self.assertEqual(packing_list.status_code, 200)

        self.login('user')
        self.assertEqual(self.client.get('/quotations/quote-123').status_code, 302)
        self.assertEqual(self.client.get('/delivery-order/999').status_code, 302)
        self.assertEqual(self.client.get('/packing-list/999').status_code, 302)

    def test_client_router_supports_history_navigation(self):
        source_path = os.path.join(os.path.dirname(app_module.__file__), 'static', 'js', 'app.js')
        with open(source_path, encoding='utf-8') as source_file:
            source = source_file.read()
        self.assertIn("'prepare-new': '/prepare'", source)
        self.assertIn("plan: '/plan'", source)
        self.assertIn("window.addEventListener('popstate'", source)
        self.assertIn("window.history[method]", source)
        self.assertIn("kind: 'quotation'", source)
        self.assertIn("kind: 'event-overview'", source)
        self.assertIn("kind: 'delivery-order'", source)
        self.assertIn("kind: 'packing-list'", source)
        self.assertIn('openPackingListPage(eventId)', source)
        self.assertIn("apiCall(`/api/events/${eventId}/overview`)", source)
        self.assertIn('function eventOverviewAssets(event)', source)
        self.assertIn('function closeEventOverview(options = {})', source)

        template_path = os.path.join(os.path.dirname(app_module.__file__), 'templates', 'index.html')
        with open(template_path, encoding='utf-8') as template_file:
            template = template_file.read()
        self.assertIn('class="modal-content event-overview-shell"', template)
        self.assertNotIn('Generate Delivery Order\n          </button>', template)


if __name__ == '__main__':
    unittest.main()
