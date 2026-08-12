import os
import tempfile

os.environ['ENABLE_HTTPS'] = '0'

import app as app_module
from data_manager import DataManager
from models import User, hash_password


data_folder = tempfile.mkdtemp(
    prefix='workflow-preview-',
    dir=os.path.dirname(__file__),
)
manager = DataManager(data_folder)
manager.setup_data_folder()
manager.users = {
    'admin': User(
        'admin',
        hash_password('preview-password', 'preview-salt'),
        'preview-salt',
        True,
        True,
        role='admin',
        has_sales_access=True,
        name='Preview Admin',
    ),
}
manager.save_users()
manager.clients = {}
manager.save_clients()
manager.events = {}

app_module.app.config['TESTING'] = True
app_module.set_data_manager_for_testing(manager)
app_module.app.run(host='127.0.0.1', port=5056, debug=False, use_reloader=False)
