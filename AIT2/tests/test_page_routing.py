import os
import tempfile
import unittest

import app as app_module
from data_manager import DataManager
from models import Event, User, hash_password
from tests.static_source import APP_BUNDLE_SOURCE


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
                'owner': 'TEST', 'admin': 'TEST', 'manager': 'TEST', 'sales': 'TEST', 'user': 'TEST',
            },
            'superAdmins': ['owner'],
        })

        self.manager = DataManager(self.tempdir.name)
        self.manager.setup_data_folder()
        self.manager.users = {
            'owner': self.make_user('owner', 'owner', True),
            'admin': self.make_user('admin', 'admin', False),
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
        for path in (
            '/plan', '/vehicles', '/quotations', '/costing', '/profit-loss',
            '/accounting', '/companies',
        ):
            response = self.client.get(path)
            self.assertEqual(response.status_code, 302, path)
            self.assertTrue(response.headers['Location'].endswith('/events'), path)

        self.login('manager')
        self.assertEqual(self.client.get('/plan').status_code, 200)
        self.assertEqual(self.client.get('/invoice-claims').status_code, 302)
        self.assertEqual(self.client.get('/manpower/41/by-department').status_code, 200)
        self.assertEqual(self.client.get('/vehicles').status_code, 200)
        self.assertEqual(self.client.get('/users').status_code, 200)
        self.assertEqual(self.client.get('/company-details').status_code, 200)
        self.assertEqual(self.client.get('/quotations').status_code, 302)
        self.assertEqual(self.client.get('/profit-loss').status_code, 302)
        self.assertEqual(self.client.get('/accounting').status_code, 302)

        self.login('admin')
        self.assertEqual(self.client.get('/accounting').status_code, 200)

        self.login('sales')
        self.assertEqual(self.client.get('/quotations').status_code, 200)
        self.assertEqual(self.client.get('/costing').status_code, 200)
        self.assertEqual(self.client.get('/profit-loss').status_code, 200)
        self.assertEqual(self.client.get('/accounting').status_code, 302)
        self.assertEqual(self.client.get('/plan').status_code, 302)

        self.login('owner')
        self.assertEqual(self.client.get('/invoice-claims').status_code, 200)
        self.assertEqual(self.client.get('/companies').status_code, 200)
        self.assertEqual(self.client.get('/quotations').status_code, 200)
        self.assertEqual(self.client.get('/costing').status_code, 200)
        self.assertEqual(self.client.get('/profit-loss').status_code, 200)
        self.assertEqual(self.client.get('/accounting').status_code, 200)

    def test_deep_link_selects_workspace_and_root_redirects(self):
        self.login('owner')
        response = self.client.get('/prepare')
        self.assertEqual(response.status_code, 200)
        page = response.get_data(as_text=True)
        self.assertIn('window.__INITIAL_APP_SECTION__ = "prepare-new"', page)
        self.assertIn('id="prepare-new-section" class="content-section active"', page)
        self.assertIn('id="events-section" class="content-section"', page)
        self.assertNotIn('id="events-section" class="content-section active"', page)

        root = self.client.get('/')
        self.assertEqual(root.status_code, 302)
        self.assertTrue(root.headers['Location'].endswith('/events'))

    def test_record_deep_links_restore_authorised_workspaces(self):
        self.login('owner')
        quotation = self.client.get('/quotations/quote-123')
        event_overview = self.client.get('/events/41')
        delivery_order = self.client.get('/delivery-order/41')
        packing_list = self.client.get('/packing-list/41')
        manpower_day = self.client.get('/manpower/41/by-day')
        manpower_department = self.client.get('/manpower/41/by-department')

        self.assertEqual(quotation.status_code, 200)
        self.assertIn('window.__INITIAL_APP_SECTION__ = "quotations"', quotation.get_data(as_text=True))
        self.assertEqual(event_overview.status_code, 200)
        self.assertIn('window.__INITIAL_APP_SECTION__ = "events"', event_overview.get_data(as_text=True))
        self.assertEqual(delivery_order.status_code, 200)
        self.assertIn('window.__INITIAL_APP_SECTION__ = "delivery-order"', delivery_order.get_data(as_text=True))
        self.assertEqual(packing_list.status_code, 200)
        self.assertEqual(manpower_day.status_code, 200)
        self.assertIn('window.__INITIAL_APP_SECTION__ = "workforce"', manpower_day.get_data(as_text=True))
        self.assertEqual(manpower_department.status_code, 200)

        self.login('user')
        self.assertEqual(self.client.get('/quotations/quote-123').status_code, 302)
        self.assertEqual(self.client.get('/delivery-order/999').status_code, 302)
        self.assertEqual(self.client.get('/packing-list/999').status_code, 302)
        self.assertEqual(self.client.get('/manpower/41/by-day').status_code, 302)

        self.login('owner')
        self.assertEqual(self.client.get('/manpower/999/by-day').status_code, 302)
        invalid_view = self.client.get('/manpower/41/by-worker')
        self.assertEqual(invalid_view.status_code, 302)
        self.assertTrue(invalid_view.headers['Location'].endswith('/manpower/41/by-department'))

    def test_unavailable_pages_fall_back_to_next_accessible_event(self):
        next_event = Event(42, 'Next Accessible Event', '20260720', '20260721', [])
        next_event.assigned_users = ['user']
        self.manager.events[42] = next_event

        self.login('user')
        for path in ('/plan', '/events/999'):
            response = self.client.get(path)
            self.assertEqual(response.status_code, 302, path)
            self.assertTrue(response.headers['Location'].endswith('/events/42'), path)

        self.login('manager')
        hidden_portal = self.client.get('/my-claims')
        self.assertEqual(hidden_portal.status_code, 302)
        self.assertTrue(hidden_portal.headers['Location'].endswith('/events/42'))

        self.login('owner')
        fallback_paths = {
            '/manpower/999/by-day': '/manpower/42/by-day',
            '/delivery-order/999': '/delivery-order/42',
            '/packing-list/999': '/packing-list/42',
        }
        for path, expected in fallback_paths.items():
            response = self.client.get(path)
            self.assertEqual(response.status_code, 302, path)
            self.assertTrue(response.headers['Location'].endswith(expected), path)

    def test_client_router_supports_history_navigation(self):
        source = APP_BUNDLE_SOURCE
        self.assertIn("'prepare-new': '/prepare'", source)
        self.assertIn("plan: '/plan'", source)
        self.assertIn("vehicles: '/vehicles'", source)
        self.assertIn("window.addEventListener('popstate'", source)
        self.assertIn("window.history[method]", source)
        self.assertIn("kind: 'quotation'", source)
        self.assertIn("kind: 'event-overview'", source)
        self.assertIn("kind: 'delivery-order'", source)
        self.assertIn("kind: 'packing-list'", source)
        self.assertIn("kind: 'workforce'", source)
        self.assertIn("/^\\/manpower\\/(\\d+)(?:\\/(by-department|by-day))?$/", source)
        self.assertIn('openPackingListPage(eventId)', source)
        self.assertIn("apiCall(`/api/events/${eventId}/overview`)", source)
        self.assertIn('function eventOverviewAssets(event)', source)
        self.assertIn('function eventOverviewSubprojects(event)', source)
        self.assertIn("eventOverviewSection('rooms', 'Sub-projects'", source)
        self.assertIn('function closeEventOverview(options = {})', source)
        self.assertNotIn('setTimeout(async () => {\n      const detailRoute = appDetailRouteFromPath();', source)
        permission_ui = source[
            source.index('function applyPermissionUi()'):
            source.index('function openEventFromCalendar')
        ]
        self.assertIn(".user-only, [data-user-only='true']", permission_ui)
        self.assertIn("currentUserRole() === 'user'", permission_ui)

        workforce_path = os.path.join(
            os.path.dirname(app_module.__file__), 'static', 'js', 'workforce-admin.js'
        )
        schedule_path = os.path.join(
            os.path.dirname(app_module.__file__), 'static', 'js', 'workforce-schedule.js'
        )
        with open(workforce_path, encoding='utf-8') as workforce_file:
            workforce_source = workforce_file.read()
        with open(schedule_path, encoding='utf-8') as schedule_file:
            schedule_source = schedule_file.read()
        self.assertIn('function restoreWorkforceRouteState(route)', workforce_source)
        self.assertIn("return `/manpower/${id}/${view}`", workforce_source)
        self.assertIn("viewMode: 'schedule'", workforce_source)
        self.assertIn("route.viewMode === 'assignments'", workforce_source)
        self.assertIn('syncWorkforceRoute({ replace: true })', workforce_source)
        self.assertIn("syncWorkforceRoute();", schedule_source)

        template_path = os.path.join(os.path.dirname(app_module.__file__), 'templates', 'index.html')
        with open(template_path, encoding='utf-8') as template_file:
            template = template_file.read()
        self.assertIn('class="modal-content event-overview-shell"', template)
        self.assertIn('id="vehicles-section"', template)
        self.assertIn("filename='js/custom-select.js'", template)
        self.assertIn("filename='css/custom-select.css'", template)
        self.assertIn('<span>Vehicles</span>', template)
        self.assertIn('.user-only {\n        display: none;', template)
        self.assertNotIn('Generate Delivery Order\n          </button>', template)


if __name__ == '__main__':
    unittest.main()
